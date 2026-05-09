import { Compass, Crop, Mic, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

import { CubeMapViewer } from './components/CubeMapViewer';
import { DEMO_SCENES } from './data/demoScenes';
import {
  CUBE_FACE_KEYS,
  cubeFacesFromGeneratedPanorama,
  CubeFaceKey,
  CubeFaceUrls,
  DEFAULT_CUBE_FACE_TRANSFORMS,
  GeneratedPanoramaCubemapResponse,
} from './lib/cubemap';
import { analyzeCubeMap, CubeMapQaReport } from './lib/cubemapQa';
import {
  cubeProjectionToDirection,
  directionToCubeProjection,
  directionToScreenPoint,
  screenPointToDirection,
  SceneEditResultPayload,
  SceneEditStatus,
  SceneSelectionRegion,
  ViewPose,
} from './lib/sceneEditing';

type SceneState = 'empty' | 'loading' | 'ready' | 'error';

type WorkspaceScene = {
  id: string;
  name: string;
  sourceImage?: File | null;
  uploadError?: string;
  panoramaId?: string;
  faces?: CubeFaceUrls;
  ownedUrls?: string[];
  qa?: CubeMapQaReport;
};

type PersistedWorkspaceScene = {
  id: string;
  name: string;
  panoramaId?: string;
  faces?: CubeFaceUrls;
};

type PersistedWorkspaceState = {
  activeSceneId: string;
  workspaces: PersistedWorkspaceScene[];
};

type FaceImagePayloads = Record<CubeFaceKey, { dataUrl: string; width: number; height: number }>;

type SelectionDebugPreview = {
  cropDataUrl: string;
  labels: string;
  box: string;
  pose: string;
  facePreviews: Array<{
    face: CubeFaceKey;
    label: string;
    imageDataUrl: string;
  }>;
};

const FACE_LABELS: Record<CubeFaceKey, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  up: 'Top',
  down: 'Bottom',
};

const WORKSPACE_STORAGE_KEY = 'scenemaker.workspaces.v1';

function makeStaticWorkspaces(): WorkspaceScene[] {
  return DEMO_SCENES.map((scene) => ({
    id: scene.id,
    name: scene.name,
    faces: scene.faces,
  }));
}

function isDurableFaceUrl(url: string) {
  return !url.startsWith('blob:') && !url.startsWith('data:');
}

function toPersistedWorkspace(scene: WorkspaceScene): PersistedWorkspaceScene {
  return {
    id: scene.id,
    name: scene.name,
    panoramaId: scene.panoramaId,
    faces: scene.panoramaId
      ? undefined
      : scene.faces && Object.values(scene.faces).every(isDurableFaceUrl)
        ? scene.faces
        : scene.faces,
  };
}

function loadPersistedWorkspaceState(): PersistedWorkspaceState {
  if (typeof window === 'undefined') {
    return { activeSceneId: 'provided', workspaces: makeStaticWorkspaces() };
  }

  try {
    const rawState = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!rawState) {
      return { activeSceneId: 'provided', workspaces: makeStaticWorkspaces() };
    }

    const state = JSON.parse(rawState) as Partial<PersistedWorkspaceState>;
    const workspaces = Array.isArray(state.workspaces)
      ? state.workspaces
          .filter(
            (scene): scene is PersistedWorkspaceScene =>
              typeof scene?.id === 'string' && typeof scene.name === 'string',
          )
          .map((scene) => ({
            id: scene.id,
            name: scene.name,
            panoramaId: scene.panoramaId,
            faces: scene.faces,
          }))
      : makeStaticWorkspaces();

    return {
      activeSceneId:
        typeof state.activeSceneId === 'string' && workspaces.some((scene) => scene.id === state.activeSceneId)
          ? state.activeSceneId
          : (workspaces[0]?.id ?? 'provided'),
      workspaces: workspaces.length > 0 ? workspaces : makeStaticWorkspaces(),
    };
  } catch {
    return { activeSceneId: 'provided', workspaces: makeStaticWorkspaces() };
  }
}

function makeUploadWorkspaceName(count: number) {
  return `Scene ${count}`;
}

function getSupportedAudioMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

export function App() {
  const [initialWorkspaceState] = useState(loadPersistedWorkspaceState);
  const [workspaces, setWorkspaces] = useState<WorkspaceScene[]>(initialWorkspaceState.workspaces);
  const [activeSceneId, setActiveSceneId] = useState(initialWorkspaceState.activeSceneId);
  const [, setSceneState] = useState<SceneState>('loading');
  const [generationStatus, setGenerationStatus] = useState<'idle' | 'generating'>('idle');
  const [editStatus, setEditStatus] = useState<SceneEditStatus>('idle');
  const [editMessage, setEditMessage] = useState('');
  const [editTranscript, setEditTranscript] = useState('');
  const [editInstruction, setEditInstruction] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<SceneSelectionRegion | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<SceneSelectionRegion | null>(null);
  const [selectionDebug, setSelectionDebug] = useState<SelectionDebugPreview | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const viewPoseRef = useRef<ViewPose>({ yaw: 0, pitch: 0, fov: 75 });
  const workspaceNameInputRef = useRef<HTMLInputElement | null>(null);

  const activeScene = useMemo(
    () => workspaces.find((scene) => scene.id === activeSceneId) ?? workspaces[0],
    [activeSceneId, workspaces],
  );
  const activeQa = activeScene?.qa;
  const activeSourceImage = activeScene?.sourceImage ?? null;
  const activeUploadError = activeScene?.uploadError ?? '';
  const canUploadSourceImage = !activeScene?.faces && !activeScene?.panoramaId;
  const canEditScene = Boolean(activeScene?.faces && activeScene.panoramaId);
  const isBusy =
    generationStatus === 'generating' ||
    editStatus === 'transcribing' ||
    editStatus === 'planning' ||
    editStatus === 'editing' ||
    editStatus === 'validating';

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        activeSceneId,
        workspaces: workspaces.map(toPersistedWorkspace),
      }),
    );
  }, [activeSceneId, workspaces]);

  useEffect(() => {
    const scenesToRestore = workspaces.filter((scene) => scene.panoramaId && !scene.faces && !scene.uploadError);

    if (scenesToRestore.length === 0) {
      return undefined;
    }

    let isActive = true;

    for (const scene of scenesToRestore) {
      void postJson<{ faces: CubeFaceUrls; panoramaId: string }>(
        `/api/panorama-cubemap-faces?panoramaId=${encodeURIComponent(scene.panoramaId!)}`,
      )
        .then(({ faces }) => {
          if (!isActive) {
            return;
          }

          setWorkspaces((current) =>
            current.map((candidate) =>
              candidate.id === scene.id
                ? {
                    ...candidate,
                    faces,
                    qa: undefined,
                  }
                : candidate,
            ),
          );
        })
        .catch(() => {
          if (isActive) {
            updateWorkspaceUploadError(scene.id, 'Unable to restore this workspace panorama.');
          }
        });
    }

    return () => {
      isActive = false;
    };
  }, [workspaces]);

  useEffect(() => {
    const faces = activeScene?.faces;

    if (!activeScene || !faces) {
      setSceneState('empty');
      return undefined;
    }

    let isActive = true;
    setSceneState('loading');

    analyzeCubeMap(faces)
      .then((qa) => {
        if (!isActive) {
          return;
        }

        setWorkspaces((current) =>
          current.map((scene) => (scene.id === activeScene.id ? { ...scene, qa } : scene)),
        );
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Unable to analyze cube map.';
        setWorkspaces((current) =>
          current.map((scene) =>
            scene.id === activeScene.id
              ? {
                  ...scene,
                  qa: {
                    severity: 'fail',
                    score: 1,
                    dimensions: {
                      front: { width: 0, height: 0 },
                      back: { width: 0, height: 0 },
                      left: { width: 0, height: 0 },
                      right: { width: 0, height: 0 },
                      up: { width: 0, height: 0 },
                      down: { width: 0, height: 0 },
                    },
                    transforms: DEFAULT_CUBE_FACE_TRANSFORMS,
                    issues: [message],
                    seamScores: [],
                  },
                }
              : scene,
          ),
        );
        setSceneState('error');
      });

    return () => {
      isActive = false;
    };
  }, [activeScene?.faces, activeScene?.id]);

  const createWorkspace = () => {
    const id = `workspace-${Date.now()}`;
    const name = makeUploadWorkspaceName(workspaces.filter((scene) => scene.id.startsWith('workspace-')).length + 1);
    setWorkspaces((current) => [...current, { id, name }]);
    setSelectedRegion(null);
    setSelectionPreview(null);
    setSelectionMode(false);
    setActiveSceneId(id);
    setSceneState('empty');
  };

  const selectWorkspace = (scene: WorkspaceScene) => {
    setSelectedRegion(null);
    setSelectionPreview(null);
    setSelectionMode(false);
    setSceneState(scene.faces ? 'loading' : 'empty');
    setActiveSceneId(scene.id);
  };

  const renameWorkspace = (id: string, name: string) => {
    setWorkspaces((current) => current.map((scene) => (scene.id === id ? { ...scene, name } : scene)));
  };

  const updateWorkspaceSource = (id: string, sourceImage: File | null, uploadError = '') => {
    setWorkspaces((current) =>
      current.map((scene) => (scene.id === id ? { ...scene, sourceImage, uploadError } : scene)),
    );
  };

  const updateWorkspaceUploadError = (id: string, uploadError: string) => {
    setWorkspaces((current) => current.map((scene) => (scene.id === id ? { ...scene, uploadError } : scene)));
  };

  const finishWorkspaceRename = () => {
    if (!activeScene) {
      return;
    }

    const trimmedName = activeScene.name.trim();
    if (trimmedName.length === 0) {
      renameWorkspace(activeScene.id, 'Untitled scene');
      return;
    }

    if (trimmedName !== activeScene.name) {
      renameWorkspace(activeScene.id, trimmedName);
    }
  };

  const startWorkspaceRename = (scene: WorkspaceScene) => {
    selectWorkspace(scene);
    window.requestAnimationFrame(() => {
      workspaceNameInputRef.current?.focus();
      workspaceNameInputRef.current?.select();
    });
  };

  const deleteWorkspace = (sceneId: string) => {
    const sceneToDelete = workspaces.find((scene) => scene.id === sceneId);

    if (sceneToDelete?.ownedUrls) {
      for (const url of sceneToDelete.ownedUrls) {
        URL.revokeObjectURL(url);
      }
    }

    const nextWorkspaces = workspaces.filter((scene) => scene.id !== sceneId);
    setWorkspaces(nextWorkspaces);

    if (sceneId === activeScene?.id) {
      const deletedIndex = workspaces.findIndex((scene) => scene.id === sceneId);
      const nextActiveScene = nextWorkspaces[Math.min(deletedIndex, nextWorkspaces.length - 1)];
      setActiveSceneId(nextActiveScene?.id ?? '');
      setSceneState(nextActiveScene?.faces ? 'loading' : 'empty');
      setSelectedRegion(null);
      setSelectionPreview(null);
      setSelectionMode(false);
      setEditStatus('idle');
      setEditMessage('');
    }
  };

  const handleSourceImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || !activeScene) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      updateWorkspaceUploadError(activeScene.id, 'Choose an image file to generate a scene.');
      return;
    }

    updateWorkspaceSource(activeScene.id, file);
  };

  const applyGeneratedFaces = (faces: CubeFaceUrls, jobId?: string, panoramaId?: string) => {
    const shouldCreateWorkspace = !activeScene?.id.startsWith('workspace-');
    const id = shouldCreateWorkspace ? `workspace-${Date.now()}` : activeScene.id;
    const name = shouldCreateWorkspace
      ? makeUploadWorkspaceName(workspaces.filter((scene) => scene.id.startsWith('workspace-')).length + 1)
      : activeScene.name;

    setWorkspaces((current) => {
      if (shouldCreateWorkspace) {
        return [...current, { id, name, faces, panoramaId }];
      }

      return current.map((scene) => {
        if (scene.id !== id) {
          return scene;
        }

        if (scene.ownedUrls) {
          for (const url of scene.ownedUrls) {
            URL.revokeObjectURL(url);
          }
        }

        return {
          ...scene,
          name,
          faces,
          panoramaId,
          sourceImage: undefined,
          uploadError: '',
          ownedUrls: undefined,
          qa: undefined,
        };
      });
    });
    setActiveSceneId(id);
    setSceneState('loading');
    setSelectedRegion(null);
    setSelectionPreview(null);
    setSelectionMode(false);
    setEditStatus('idle');
    setEditMessage(jobId ? `Generated panorama job ${jobId}.` : 'Generated panorama scene.');
  };

  const generateSceneFromUpload = async () => {
    if (!activeScene) {
      return;
    }

    if (!activeSourceImage) {
      updateWorkspaceUploadError(activeScene.id, 'Choose one source image first.');
      return;
    }

    const formData = new FormData();
    formData.set('image', activeSourceImage);
    formData.set('description', 'LOL');

    try {
      updateWorkspaceUploadError(activeScene.id, '');
      setGenerationStatus('generating');
      setSceneState('loading');
      const response = await fetch('/api/generate-panorama-cubemap', {
        method: 'POST',
        body: formData,
      });
      const payload = (await response.json()) as GeneratedPanoramaCubemapResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Scene generation failed.');
      }

      applyGeneratedFaces(cubeFacesFromGeneratedPanorama(payload.faces), payload.job_id, payload.panoramaId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scene generation failed.';
      updateWorkspaceUploadError(activeScene.id, message);
      setSceneState(activeScene?.faces ? 'ready' : 'empty');
    } finally {
      setGenerationStatus('idle');
    }
  };

  const blobToDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read media data.'));
      reader.readAsDataURL(blob);
    });

  const urlToDataUrl = async (url: string) => {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Unable to load cube face for editing: ${url}`);
    }

    return blobToDataUrl(await response.blob());
  };

  const loadImageDimensions = (dataUrl: string) =>
    new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Unable to read cube face dimensions.'));
      image.src = dataUrl;
    });

  const loadFacePayloads = async (faces: CubeFaceUrls) => {
    const entries = await Promise.all(
      CUBE_FACE_KEYS.map(async (face) => {
        const dataUrl = await urlToDataUrl(faces[face]);
        const dimensions = await loadImageDimensions(dataUrl);
        return [face, { dataUrl, ...dimensions }] as const;
      }),
    );

    return Object.fromEntries(entries) as FaceImagePayloads;
  };

  const dataUrlToObjectUrl = async (dataUrl: string) => {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  };

  const loadCanvasImage = (dataUrl: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Unable to load generated edit image.'));
      image.src = dataUrl;
    });

  const renderSelectionCropDataUrl = async (region: SceneSelectionRegion, facePayloads: FaceImagePayloads) => {
    const cropWidth = 512;
    const cropHeight = Math.max(96, Math.round((cropWidth * region.box.height) / Math.max(region.box.width, 0.001)));
    const sourceImages = Object.fromEntries(
      await Promise.all(
        CUBE_FACE_KEYS.map(async (face) => [face, await loadCanvasImage(facePayloads[face].dataUrl)] as const),
      ),
    ) as Record<CubeFaceKey, HTMLImageElement>;
    const sourcePixels = Object.fromEntries(
      CUBE_FACE_KEYS.map((face) => {
        const canvas = document.createElement('canvas');
        canvas.width = facePayloads[face].width;
        canvas.height = facePayloads[face].height;
        const context = canvas.getContext('2d', { willReadFrequently: true });

        if (!context) {
          throw new Error('Unable to prepare selected crop.');
        }

        context.drawImage(sourceImages[face], 0, 0, canvas.width, canvas.height);
        return [face, context.getImageData(0, 0, canvas.width, canvas.height)] as const;
      }),
    ) as Record<CubeFaceKey, ImageData>;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropContext = cropCanvas.getContext('2d', { willReadFrequently: true });

    if (!cropContext) {
      throw new Error('Unable to render selected crop.');
    }

    const cropPixels = cropContext.createImageData(cropWidth, cropHeight);

    for (let y = 0; y < cropHeight; y += 1) {
      for (let x = 0; x < cropWidth; x += 1) {
        const screenX = region.box.left + ((x + 0.5) / cropWidth) * region.box.width;
        const screenY = region.box.top + ((y + 0.5) / cropHeight) * region.box.height;
        const projection = directionToCubeProjection(
          screenPointToDirection({ x: screenX * 2 - 1, y: screenY * 2 - 1 }, region.pose, region.aspect),
        );
        const faceDimensions = facePayloads[projection.face];
        const sourceData = sourcePixels[projection.face].data;
        const sourceX = Math.min(Math.max(Math.floor(projection.u * faceDimensions.width), 0), faceDimensions.width - 1);
        const sourceY = Math.min(Math.max(Math.floor(projection.v * faceDimensions.height), 0), faceDimensions.height - 1);
        const sourceIndex = (sourceY * faceDimensions.width + sourceX) * 4;
        const targetIndex = (y * cropWidth + x) * 4;

        cropPixels.data[targetIndex] = sourceData[sourceIndex];
        cropPixels.data[targetIndex + 1] = sourceData[sourceIndex + 1];
        cropPixels.data[targetIndex + 2] = sourceData[sourceIndex + 2];
        cropPixels.data[targetIndex + 3] = 255;
      }
    }

    cropContext.putImageData(cropPixels, 0, 0);
    return cropCanvas.toDataURL('image/png');
  };

  const createSelectionMaskPngBase64 = (
    region: SceneSelectionRegion,
    face: CubeFaceKey,
    dimensions: { width: number; height: number },
    expandRatio: number,
  ) => {
    const faceRegion = region.faces.find((candidate) => candidate.face === face);

    if (!faceRegion) {
      throw new Error(`No selected region found for ${face}.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (!context) {
      throw new Error('Unable to create selected-region edit mask.');
    }

    const imageData = context.createImageData(dimensions.width, dimensions.height);
    const { data } = imageData;
    const feather = Math.max(0.006, Math.min(region.box.width, region.box.height) * 0.055);
    const boxLeft = Math.max(region.box.left - expandRatio, 0);
    const boxRight = Math.min(region.box.left + region.box.width + expandRatio, 1);
    const boxTop = Math.max(region.box.top - expandRatio, 0);
    const boxBottom = Math.min(region.box.top + region.box.height + expandRatio, 1);

    for (let y = 0; y < dimensions.height; y += 1) {
      for (let x = 0; x < dimensions.width; x += 1) {
        const u = (x + 0.5) / dimensions.width;
        const v = (y + 0.5) / dimensions.height;
        const screenPoint = directionToScreenPoint(cubeProjectionToDirection(face, u, v), region.pose, region.aspect);
        const index = (y * dimensions.width + x) * 4;
        let alpha = 255;

        if (screenPoint) {
          const screenX = (screenPoint.x + 1) / 2;
          const screenY = (screenPoint.y + 1) / 2;
          const insideX = screenX >= boxLeft && screenX <= boxRight;
          const insideY = screenY >= boxTop && screenY <= boxBottom;

          if (insideX && insideY) {
            const edgeDistance = Math.min(screenX - boxLeft, boxRight - screenX, screenY - boxTop, boxBottom - screenY);
            alpha = Math.round(255 * Math.min(Math.max(1 - edgeDistance / feather, 0), 1));
          }
        }

        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = alpha;
      }
    }

    context.putImageData(imageData, 0, 0);

    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  };

  const renderFaceRegionDebugDataUrl = async (
    region: SceneSelectionRegion,
    face: CubeFaceKey,
    payload: { dataUrl: string; width: number; height: number },
  ) => {
    const width = 360;
    const height = Math.max(1, Math.round((width * payload.height) / Math.max(payload.width, 1)));
    const [sourceImage, maskImage] = await Promise.all([
      loadCanvasImage(payload.dataUrl),
      loadCanvasImage(`data:image/png;base64,${createSelectionMaskPngBase64(region, face, payload, 0.006)}`),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (!context) {
      throw new Error('Unable to render selected face debug preview.');
    }

    context.drawImage(maskImage, 0, 0, width, height);
    const maskPixels = context.getImageData(0, 0, width, height);
    context.clearRect(0, 0, width, height);
    context.drawImage(sourceImage, 0, 0, width, height);
    context.fillStyle = 'rgba(8, 7, 6, 0.48)';
    context.fillRect(0, 0, width, height);

    const overlay = context.createImageData(width, height);

    for (let index = 0; index < overlay.data.length; index += 4) {
      const selectionStrength = 1 - maskPixels.data[index + 3] / 255;

      if (selectionStrength <= 0.01) {
        continue;
      }

      overlay.data[index] = 88;
      overlay.data[index + 1] = 214;
      overlay.data[index + 2] = 199;
      overlay.data[index + 3] = Math.round(selectionStrength * 170);
    }

    context.putImageData(overlay, 0, 0);
    context.strokeStyle = '#58d6c7';
    context.lineWidth = 3;
    context.strokeRect(1.5, 1.5, width - 3, height - 3);

    return canvas.toDataURL('image/png');
  };

  useEffect(() => {
    const region = selectionPreview ?? selectedRegion;
    const faces = activeScene?.faces;

    if (!region || !faces) {
      setSelectionDebug(null);
      return undefined;
    }

    let isActive = true;

    loadFacePayloads(faces)
      .then(async (facePayloads) => {
        const cropDataUrl = await renderSelectionCropDataUrl(region, facePayloads);
        const facePreviews = await Promise.all(
          region.faces.map(async (faceRegion) => ({
            face: faceRegion.face,
            label: FACE_LABELS[faceRegion.face],
            imageDataUrl: await renderFaceRegionDebugDataUrl(region, faceRegion.face, facePayloads[faceRegion.face]),
          })),
        );

        if (!isActive) {
          return;
        }

        setSelectionDebug({
          cropDataUrl,
          facePreviews,
          labels: region.faces.map((faceRegion) => FACE_LABELS[faceRegion.face]).join(' + '),
          box: `${Math.round(region.box.left * 100)}%, ${Math.round(region.box.top * 100)}%, ${Math.round(
            region.box.width * 100,
          )}% x ${Math.round(region.box.height * 100)}%`,
          pose: `yaw ${region.pose.yaw.toFixed(1)}, pitch ${region.pose.pitch.toFixed(1)}, fov ${region.pose.fov.toFixed(1)}`,
        });
      })
      .catch(() => {
        if (isActive) {
          setSelectionDebug(null);
        }
      });

    return () => {
      isActive = false;
    };
  }, [activeScene?.faces, selectedRegion, selectionPreview]);

  const postJson = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? 'Scene edit request failed.');
    }

    return payload;
  };

  const applySceneEditFromTranscript = async (transcript: string) => {
    if (!activeScene?.faces) {
      setEditStatus('failed');
      setEditMessage('Load a scene before editing.');
      return;
    }

    if (!activeScene.panoramaId) {
      setEditStatus('failed');
      setEditMessage('This scene does not have a stored panorama. Generate a new scene before editing.');
      return;
    }

    try {
      setEditTranscript(transcript);
      setEditStatus('editing');
      setEditMessage('Editing the stored panorama and rebuilding cube faces');
      const result = await postJson<SceneEditResultPayload>('/api/scene-edits/apply', {
        panoramaId: activeScene.panoramaId,
        instruction: transcript,
      });
      const ownedUrls = await Promise.all(CUBE_FACE_KEYS.map((face) => dataUrlToObjectUrl(result.faces[face])));
      const faces = Object.fromEntries(CUBE_FACE_KEYS.map((face, index) => [face, ownedUrls[index]])) as CubeFaceUrls;
      const qa = await analyzeCubeMap(faces);

      setWorkspaces((current) =>
        current.map((scene) => {
          if (scene.id !== activeScene.id) {
            return scene;
          }

          if (scene.ownedUrls) {
            for (const url of scene.ownedUrls) {
              URL.revokeObjectURL(url);
            }
          }

          objectUrlsRef.current.push(...ownedUrls);
          return {
            ...scene,
            faces,
            panoramaId: result.panoramaId ?? scene.panoramaId,
            ownedUrls,
            qa,
          };
        }),
      );
      setSceneState('loading');
      setEditStatus('ready');
      setSelectedRegion(null);
      setEditInstruction('');
      setEditMessage(`Applied: ${transcript}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scene edit failed.';
      setEditStatus('failed');
      setEditMessage(message);
    }
  };

  const applySceneEdit = async (audioBlob: Blob) => {
    try {
      setEditStatus('transcribing');
      setEditMessage('Transcribing voice edit');
      const audioBase64 = await blobToDataUrl(audioBlob);
      const { transcript } = await postJson<{ transcript: string }>('/api/transcribe', { audioBase64 });
      await applySceneEditFromTranscript(transcript);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice scene edit failed.';
      setEditStatus('failed');
      setEditMessage(message);
    }
  };

  const applyTypedInstruction = () => {
    const instruction = editInstruction.trim();

    if (!instruction) {
      setEditStatus('failed');
      setEditMessage('Type what should change first.');
      return;
    }

    setSelectionMode(false);
    void applySceneEditFromTranscript(instruction);
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const startRecording = async () => {
    if (!activeScene?.faces) {
      setEditStatus('failed');
      setEditMessage('Load a scene before using voice edits.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setEditStatus('failed');
      setEditMessage('This browser does not support microphone recording.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioMimeType = getSupportedAudioMimeType();
      const recorder = audioMimeType ? new MediaRecorder(stream, { mimeType: audioMimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];
      setSelectionMode(false);
      setEditTranscript('');
      setEditMessage(
        selectedRegion
          ? `Listening for selected box across ${selectedRegion.faces.length} cube face${selectedRegion.faces.length === 1 ? '' : 's'}. Tap the mic again to apply.`
          : 'Listening. Tap the mic again to apply.',
      );
      setEditStatus('listening');

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        const audioType = recorder.mimeType || recordedChunksRef.current.find((chunk) => chunk instanceof Blob)?.type || 'audio/webm';
        const audioBlob = new Blob(recordedChunksRef.current, { type: audioType });
        recordedChunksRef.current = [];

        if (audioBlob.size === 0) {
          setEditStatus('failed');
          setEditMessage('No audio was recorded. Try holding the mic recording a little longer.');
          return;
        }

        void applySceneEdit(audioBlob);
      };

      recorder.start(250);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone permission was not granted.';
      setEditStatus('failed');
      setEditMessage(message);
    }
  };

  const toggleMic = () => {
    if (editStatus === 'listening') {
      stopRecording();
      return;
    }

    if (isBusy) {
      return;
    }

    void startRecording();
  };

  const toggleSelectionMode = () => {
    if (editStatus === 'listening') {
      return;
    }

    setSelectionMode((current) => {
      const next = !current;
      setSelectionPreview(null);
      setEditMessage(next ? 'Drag a box on the scene, then type the edit or tap the mic.' : '');
      return next;
    });
  };

  return (
    <main className="app-shell">
      {activeScene?.faces ? (
        <CubeMapViewer
          key={activeScene.id}
          faces={activeScene.faces}
          transforms={activeQa?.transforms}
          className="app-viewer"
          initialYaw={0}
          initialPitch={0}
          minFov={32}
          maxFov={96}
          selectionMode={selectionMode}
          onViewChange={(pose) => {
            viewPoseRef.current = pose;
          }}
          onSelectionPreview={(selection) => {
            setSelectionPreview(selection);
          }}
          onSelectionComplete={(selection) => {
            setSelectedRegion(selection);
            setSelectionPreview(selection);
            setSelectionMode(false);
            setEditStatus('idle');
            setEditMessage(
              `Selected box touches ${selection.faces.length} cube face${selection.faces.length === 1 ? '' : 's'}. Type the edit or tap the mic.`,
            );
          }}
          onReady={() => setSceneState('ready')}
          onError={() => setSceneState('error')}
        />
      ) : (
        <section className="empty-view" aria-label="Empty workspace" />
      )}

      <header className="app-topbar">
        <div className="app-brand" aria-label="SceneMaker 360">
          <Compass size={20} aria-hidden="true" />
          <span>SceneMaker 360</span>
        </div>

        <div className="workspace-strip" aria-label="Scene workspaces">
          <button type="button" className="icon-button workspace-add" aria-label="Add scene" onClick={createWorkspace}>
            <Plus size={18} strokeWidth={2.4} />
          </button>
          <div className="scene-switcher" role="tablist" aria-label="Scene set">
            {workspaces.map((scene) => (
              <div key={scene.id} className="scene-switcher__item" role="presentation">
                <button
                  type="button"
                  role="tab"
                  aria-selected={scene.id === activeScene?.id}
                  className="scene-switcher__button"
                  onClick={() => {
                    selectWorkspace(scene);
                  }}
                >
                  {scene.name}
                </button>
                <button
                  type="button"
                  className="scene-switcher__action"
                  aria-label={`Rename ${scene.name}`}
                  onClick={() => startWorkspaceRename(scene)}
                >
                  <Pencil size={13} strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  className="scene-switcher__action scene-switcher__action--danger"
                  aria-label={`Delete ${scene.name}`}
                  onClick={() => deleteWorkspace(scene.id)}
                >
                  <Trash2 size={13} strokeWidth={2.4} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </header>

      <section className="workspace-panel" aria-label="Workspace controls">
        <div className="workspace-panel__header">
          <div className="workspace-panel__title">
            <span className="workspace-panel__eyebrow">Workspace</span>
            <input
              ref={workspaceNameInputRef}
              className="workspace-name-input"
              aria-label="Workspace name"
              value={activeScene?.name ?? ''}
              disabled={!activeScene}
              onChange={(event) => {
                if (activeScene) {
                  renameWorkspace(activeScene.id, event.target.value);
                }
              }}
              onBlur={finishWorkspaceRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
          {canEditScene ? (
            <>
              <button
                type="button"
                className={`mic-button mic-button--${editStatus}`}
                aria-label={editStatus === 'listening' ? 'Stop recording and modify scene' : 'Speak to modify scene'}
                aria-pressed={editStatus === 'listening'}
                disabled={isBusy}
                onClick={toggleMic}
              >
                <Mic size={18} strokeWidth={2.4} />
              </button>
              <button
                type="button"
                className={`region-button ${selectionMode ? 'region-button--active' : ''}`}
                aria-label={selectionMode ? 'Cancel edit region selection' : 'Select edit region'}
                aria-pressed={selectionMode}
                disabled={isBusy}
                onClick={toggleSelectionMode}
              >
                <Crop size={18} strokeWidth={2.4} />
              </button>
            </>
          ) : null}
        </div>

        {canEditScene ? (
          <>
            <div className={`edit-status edit-status--${editStatus}`} role="status" aria-live="polite">
              <span>{editStatus}</span>
              <strong>{editMessage || 'Type an edit or tap the mic to modify the current view'}</strong>
              {selectedRegion ? (
                <p>
                  Box target: {selectedRegion.faces.map((faceRegion) => FACE_LABELS[faceRegion.face]).join(', ')}
                </p>
              ) : null}
              {editTranscript ? <p>{editTranscript}</p> : null}
            </div>

            <div className="text-edit-form" aria-label="Typed scene edit">
              <input
                type="text"
                value={editInstruction}
                placeholder={selectedRegion ? 'Describe the change inside the box' : 'Describe a localized scene change'}
                disabled={isBusy || editStatus === 'listening'}
                onChange={(event) => setEditInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    applyTypedInstruction();
                  }
                }}
              />
              <button type="button" disabled={isBusy || editStatus === 'listening'} onClick={applyTypedInstruction}>
                Apply
              </button>
            </div>
          </>
        ) : null}

        {canUploadSourceImage ? (
          <>
            <div className="source-upload" aria-label="Source image upload">
              <label className="source-upload__dropzone">
                <Upload size={18} aria-hidden="true" />
                <span>Source image</span>
                <strong>{activeSourceImage?.name ?? 'Choose image'}</strong>
                <input
                  type="file"
                  accept="image/*"
                  disabled={generationStatus === 'generating'}
                  onChange={handleSourceImageUpload}
                />
              </label>
            </div>

            <button
              type="button"
              className="primary-action"
              disabled={generationStatus === 'generating'}
              onClick={() => {
                void generateSceneFromUpload();
              }}
            >
              {generationStatus === 'generating' ? 'Generating scene...' : 'Generate 360 scene'}
            </button>
            {activeUploadError ? <p className="panel-error">{activeUploadError}</p> : null}
            <p className="panel-note">
              {generationStatus === 'generating'
                ? 'This can take about 2 minutes.'
                : activeSourceImage
                  ? 'Ready to generate from one image.'
                  : 'Upload one image to start.'}
            </p>
          </>
        ) : null}
      </section>

      {selectionDebug ? (
        <aside className="selection-debug-panel" aria-label="Selected crop debug preview" aria-live="polite">
          <div className="selection-debug-panel__header">
            <span>Selected crop</span>
            <strong>{selectionDebug.labels}</strong>
          </div>
          <img className="selection-debug-panel__crop" src={selectionDebug.cropDataUrl} alt="Selected viewport crop" />
          <dl className="selection-debug-panel__meta">
            <div>
              <dt>Box</dt>
              <dd>{selectionDebug.box}</dd>
            </div>
            <div>
              <dt>Pose</dt>
              <dd>{selectionDebug.pose}</dd>
            </div>
          </dl>
          <div className="selection-debug-panel__faces" aria-label="Cube face regions sent to edit">
            {selectionDebug.facePreviews.map((preview) => (
              <figure key={preview.face}>
                <img src={preview.imageDataUrl} alt={`${preview.label} cube face edit region`} />
                <figcaption>{preview.label}</figcaption>
              </figure>
            ))}
          </div>
        </aside>
      ) : null}
    </main>
  );
}
