import {
  AlertTriangle,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';

import {
  clamp,
  clampFov,
  clampPitchDegrees,
  CubeFaceUrls,
  CUBE_FACE_KEYS,
  CubeFaceKey,
  CubeFaceTransforms,
  DEFAULT_INITIAL_FOV,
  DEFAULT_MAX_FOV,
  DEFAULT_MIN_FOV,
  DEFAULT_CUBE_FACE_TRANSFORMS,
  degreesToRadians,
  radiansToDegrees,
  validateCubeFaces,
} from '../lib/cubemap';
import { SceneSelectionRegion, selectionBoxToRegion, ViewPose } from '../lib/sceneEditing';

export type CubeMapViewerProps = {
  faces: CubeFaceUrls;
  initialYaw?: number;
  initialPitch?: number;
  minFov?: number;
  maxFov?: number;
  autoRotate?: boolean;
  transforms?: Partial<CubeFaceTransforms>;
  className?: string;
  selectionMode?: boolean;
  onSelectionPreview?: (selection: SceneSelectionRegion | null) => void;
  onViewChange?: (pose: ViewPose) => void;
  onSelectionComplete?: (selection: SceneSelectionRegion) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
};

type ViewerStatus = 'loading' | 'ready' | 'error';

type PointerPoint = {
  x: number;
  y: number;
};

type SelectionBox = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

const SKYBOX_SIZE = 500;
const DRAG_SENSITIVITY = 0.003;
const WHEEL_ZOOM_SENSITIVITY = 0.03;
const PINCH_ZOOM_SENSITIVITY = 0.04;
const AUTO_ROTATE_SPEED = 0.00025;

const FACE_CORNERS: Record<CubeFaceKey, Array<[number, number, number]>> = {
  front: [
    [-1, 1, -1],
    [1, 1, -1],
    [1, -1, -1],
    [-1, -1, -1],
  ],
  right: [
    [1, 1, -1],
    [1, 1, 1],
    [1, -1, 1],
    [1, -1, -1],
  ],
  back: [
    [1, 1, 1],
    [-1, 1, 1],
    [-1, -1, 1],
    [1, -1, 1],
  ],
  left: [
    [-1, 1, 1],
    [-1, 1, -1],
    [-1, -1, -1],
    [-1, -1, 1],
  ],
  up: [
    [-1, 1, 1],
    [1, 1, 1],
    [1, 1, -1],
    [-1, 1, -1],
  ],
  down: [
    [-1, -1, -1],
    [1, -1, -1],
    [1, -1, 1],
    [-1, -1, 1],
  ],
};

const FACE_UVS_BY_ROTATION: Record<0 | 90 | 180 | 270, Float32Array> = {
  0: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  90: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
  180: new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]),
  270: new Float32Array([1, 1, 1, 0, 0, 0, 0, 1]),
};
const FACE_INDICES = [0, 1, 2, 0, 2, 3];

function getPointerDistance(points: PointerPoint[]) {
  const [a, b] = points;
  if (!a || !b) {
    return 0;
  }

  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getReadableLoadError(source: unknown) {
  if (source instanceof Error) {
    return source;
  }

  return new Error('Unable to load the cube-map image set.');
}

function createFaceGeometry(face: CubeFaceKey, transforms: CubeFaceTransforms) {
  const positions = new Float32Array(
    FACE_CORNERS[face].flatMap(([x, y, z]) => [x * SKYBOX_SIZE, y * SKYBOX_SIZE, z * SKYBOX_SIZE]),
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(FACE_UVS_BY_ROTATION[transforms[face]], 2));
  geometry.setIndex(FACE_INDICES);
  geometry.computeVertexNormals();
  return geometry;
}

function loadTexture(url: string) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

function disposeSkybox(group: THREE.Group | null) {
  if (!group) {
    return;
  }

  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();

      if (Array.isArray(child.material)) {
        for (const material of child.material) {
          material.map?.dispose();
          material.dispose();
        }
      } else {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
  }
}

export function CubeMapViewer({
  faces,
  initialYaw = 0,
  initialPitch = 0,
  minFov = DEFAULT_MIN_FOV,
  maxFov = DEFAULT_MAX_FOV,
  autoRotate = false,
  transforms,
  className,
  selectionMode = false,
  onSelectionPreview,
  onViewChange,
  onSelectionComplete,
  onReady,
  onError,
}: CubeMapViewerProps) {
  const viewerId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const skyboxRef = useRef<THREE.Group | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const lastPinchDistanceRef = useRef<number | null>(null);
  const isInteractingRef = useRef(false);
  const isAutoRotatingRef = useRef(autoRotate);
  const yawRef = useRef(degreesToRadians(initialYaw));
  const pitchRef = useRef(degreesToRadians(clampPitchDegrees(initialPitch)));
  const fovRef = useRef(clampFov(DEFAULT_INITIAL_FOV, minFov, maxFov));
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onViewChangeRef = useRef(onViewChange);
  const onSelectionPreviewRef = useRef(onSelectionPreview);
  const onSelectionCompleteRef = useRef(onSelectionComplete);

  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [isAutoRotating, setIsAutoRotating] = useState(autoRotate);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);

  const minSafeFov = Math.min(minFov, maxFov);
  const maxSafeFov = Math.max(minFov, maxFov);
  const rootClassName = useMemo(
    () => ['cube-map-viewer', selectionMode ? 'cube-map-viewer--selecting' : '', className].filter(Boolean).join(' '),
    [className, selectionMode],
  );
  const resolvedTransforms = useMemo(
    () => ({ ...DEFAULT_CUBE_FACE_TRANSFORMS, ...transforms }),
    [transforms],
  );

  const resetView = useCallback(() => {
    yawRef.current = -degreesToRadians(initialYaw);
    pitchRef.current = degreesToRadians(clampPitchDegrees(initialPitch));
    fovRef.current = clampFov(DEFAULT_INITIAL_FOV, minSafeFov, maxSafeFov);
  }, [initialPitch, initialYaw, maxSafeFov, minSafeFov]);

  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onViewChangeRef.current = onViewChange;
    onSelectionPreviewRef.current = onSelectionPreview;
    onSelectionCompleteRef.current = onSelectionComplete;
  }, [onError, onReady, onSelectionComplete, onSelectionPreview, onViewChange]);

  useEffect(() => {
    setIsAutoRotating(autoRotate);
  }, [autoRotate]);

  useEffect(() => {
    isAutoRotatingRef.current = isAutoRotating;
  }, [isAutoRotating]);

  useEffect(() => {
    resetView();
  }, [resetView]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(fovRef.current, 1, 0.1, 1000);
    camera.rotation.order = 'YXZ';

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x111111, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = 'cube-map-viewer__canvas';
    renderer.domElement.setAttribute('aria-labelledby', viewerId);
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;

    const updateSize = () => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    const animate = () => {
      if (isAutoRotatingRef.current && !isInteractingRef.current) {
        yawRef.current += AUTO_ROTATE_SPEED;
      }

      camera.fov = fovRef.current;
      camera.rotation.y = yawRef.current;
      camera.rotation.x = pitchRef.current;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      onViewChangeRef.current?.({
        yaw: -radiansToDegrees(yawRef.current),
        pitch: radiansToDegrees(pitchRef.current),
        fov: fovRef.current,
      });
      animationFrameRef.current = window.requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }

      resizeObserver.disconnect();
      disposeSkybox(skyboxRef.current);
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      skyboxRef.current = null;
    };
  }, [viewerId]);

  useEffect(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return undefined;
    }

    const canvas = renderer.domElement;

    const handlePointerDown = (event: PointerEvent) => {
      isInteractingRef.current = true;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      lastPinchDistanceRef.current = null;
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const previousPoint = pointersRef.current.get(event.pointerId);

      if (!previousPoint) {
        return;
      }

      event.preventDefault();
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const activePoints = Array.from(pointersRef.current.values());

      if (activePoints.length >= 2) {
        const distance = getPointerDistance(activePoints);
        const lastDistance = lastPinchDistanceRef.current;

        if (lastDistance !== null) {
          fovRef.current = clamp(
            fovRef.current - (distance - lastDistance) * PINCH_ZOOM_SENSITIVITY,
            minSafeFov,
            maxSafeFov,
          );
        }

        lastPinchDistanceRef.current = distance;
        return;
      }

      const deltaX = event.clientX - previousPoint.x;
      const deltaY = event.clientY - previousPoint.y;
      yawRef.current -= deltaX * DRAG_SENSITIVITY;
      pitchRef.current = degreesToRadians(
        clampPitchDegrees((pitchRef.current - deltaY * DRAG_SENSITIVITY) * (180 / Math.PI)),
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);

      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      lastPinchDistanceRef.current = null;
      isInteractingRef.current = pointersRef.current.size > 0;
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      fovRef.current = clamp(
        fovRef.current + event.deltaY * WHEEL_ZOOM_SENSITIVITY,
        minSafeFov,
        maxSafeFov,
      );
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);
    canvas.addEventListener('lostpointercapture', handlePointerUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('lostpointercapture', handlePointerUp);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [maxSafeFov, minSafeFov]);

  useEffect(() => {
    const scene = sceneRef.current;

    if (!scene) {
      return undefined;
    }

    let isActive = true;

    try {
      const validFaces = validateCubeFaces(faces);
      setStatus('loading');
      setErrorMessage('');

      Promise.all(CUBE_FACE_KEYS.map(async (face) => [face, await loadTexture(validFaces[face])] as const))
        .then((entries) => {
          if (!isActive) {
            for (const [, texture] of entries) {
              texture.dispose();
            }
            return;
          }

          const group = new THREE.Group();

          for (const [face, texture] of entries) {
            const material = new THREE.MeshBasicMaterial({
              map: texture,
              side: THREE.DoubleSide,
              depthWrite: false,
            });
            const mesh = new THREE.Mesh(createFaceGeometry(face, resolvedTransforms), material);
            mesh.frustumCulled = false;
            group.add(mesh);
          }

          if (skyboxRef.current) {
            scene.remove(skyboxRef.current);
            disposeSkybox(skyboxRef.current);
          }

          skyboxRef.current = group;
          scene.add(group);
          setStatus('ready');
          onReadyRef.current?.();
        })
        .catch((loadError) => {
          if (!isActive) {
            return;
          }

          const error = getReadableLoadError(loadError);
          setStatus('error');
          setErrorMessage(error.message);
          onErrorRef.current?.(error);
        });
    } catch (validationError) {
      const error = getReadableLoadError(validationError);
      setStatus('error');
      setErrorMessage(error.message);
      onErrorRef.current?.(error);
    }

    return () => {
      isActive = false;
    };
  }, [faces, resolvedTransforms]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch (fullscreenError) {
      const error = getReadableLoadError(fullscreenError);
      setErrorMessage(error.message);
      onErrorRef.current?.(error);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const arrowStep = 0.06;

      if (event.key === 'ArrowLeft') {
        yawRef.current += arrowStep;
      } else if (event.key === 'ArrowRight') {
        yawRef.current -= arrowStep;
      } else if (event.key === 'ArrowUp') {
        pitchRef.current = degreesToRadians(clampPitchDegrees((pitchRef.current + arrowStep) * (180 / Math.PI)));
      } else if (event.key === 'ArrowDown') {
        pitchRef.current = degreesToRadians(clampPitchDegrees((pitchRef.current - arrowStep) * (180 / Math.PI)));
      } else if (event.key === '+' || event.key === '=') {
        fovRef.current = clamp(fovRef.current - 3, minSafeFov, maxSafeFov);
      } else if (event.key === '-' || event.key === '_') {
        fovRef.current = clamp(fovRef.current + 3, minSafeFov, maxSafeFov);
      } else if (event.key === 'Home') {
        resetView();
      } else {
        return;
      }

      event.preventDefault();
    },
    [maxSafeFov, minSafeFov, resetView],
  );

  const getSelectionRectangle = useCallback((box: SelectionBox) => {
    const left = Math.min(box.startX, box.currentX);
    const top = Math.min(box.startY, box.currentY);
    const width = Math.abs(box.currentX - box.startX);
    const height = Math.abs(box.currentY - box.startY);

    return { left, top, width, height };
  }, []);

  const getCurrentSelectionRegion = useCallback(
    (rectangle: { left: number; top: number; width: number; height: number }) => {
      const container = containerRef.current;
      const aspect = container ? Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1) : 1;

      return selectionBoxToRegion(
        rectangle,
        {
          yaw: -radiansToDegrees(yawRef.current),
          pitch: radiansToDegrees(pitchRef.current),
          fov: fovRef.current,
        },
        aspect,
      );
    },
    [],
  );

  const handleSelectionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!selectionMode || event.button !== 0) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectionBox({ startX: x, startY: y, currentX: x, currentY: y });
      onSelectionPreviewRef.current?.(null);
    },
    [selectionMode],
  );

  const handleSelectionPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!selectionMode || !selectionBox) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      setSelectionBox((current) => {
        if (!current) {
          return current;
        }

        const next = { ...current, currentX: x, currentY: y };
        const rectangle = getSelectionRectangle(next);

        if (rectangle.width >= 0.02 && rectangle.height >= 0.02) {
          onSelectionPreviewRef.current?.(getCurrentSelectionRegion(rectangle));
        } else {
          onSelectionPreviewRef.current?.(null);
        }

        return next;
      });
    },
    [getCurrentSelectionRegion, getSelectionRectangle, selectionBox, selectionMode],
  );

  const handleSelectionPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!selectionMode || !selectionBox) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const rectangle = getSelectionRectangle(selectionBox);
      setSelectionBox(null);

      if (rectangle.width < 0.02 || rectangle.height < 0.02) {
        onSelectionPreviewRef.current?.(null);
        return;
      }

      const region = getCurrentSelectionRegion(rectangle);
      onSelectionPreviewRef.current?.(region);
      onSelectionCompleteRef.current?.(region);
    },
    [getCurrentSelectionRegion, getSelectionRectangle, selectionBox, selectionMode],
  );

  const selectionRectangle = selectionBox ? getSelectionRectangle(selectionBox) : null;

  return (
    <div
      ref={containerRef}
      className={rootClassName}
      onKeyDown={handleKeyDown}
      role="application"
      aria-label="360 degree cube-map viewer"
      tabIndex={0}
    >
      <span id={viewerId} className="sr-only">
        360 degree scene
      </span>

      {selectionMode ? (
        <div
          className="cube-map-viewer__selection-layer"
          aria-label="Drag to select scene edit region"
          role="presentation"
          onPointerDown={handleSelectionPointerDown}
          onPointerMove={handleSelectionPointerMove}
          onPointerUp={handleSelectionPointerUp}
          onPointerCancel={handleSelectionPointerUp}
        >
          {selectionRectangle ? (
            <div
              className="cube-map-viewer__selection-box"
              style={{
                left: `${selectionRectangle.left * 100}%`,
                top: `${selectionRectangle.top * 100}%`,
                width: `${selectionRectangle.width * 100}%`,
                height: `${selectionRectangle.height * 100}%`,
              }}
            />
          ) : null}
        </div>
      ) : null}

      <div className="cube-map-viewer__toolbar" aria-label="Viewer controls">
        <button type="button" className="icon-button" aria-label="Reset view" onClick={resetView}>
          <RotateCcw size={18} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={isAutoRotating ? 'Pause rotation' : 'Start rotation'}
          aria-pressed={isAutoRotating}
          onClick={() => setIsAutoRotating((value) => !value)}
        >
          {isAutoRotating ? <Pause size={18} strokeWidth={2.2} /> : <Play size={18} strokeWidth={2.2} />}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={18} strokeWidth={2.2} /> : <Maximize2 size={18} strokeWidth={2.2} />}
        </button>
      </div>

      {status === 'loading' ? (
        <div className="cube-map-viewer__status" role="status">
          <LoaderCircle className="cube-map-viewer__spinner" size={26} aria-hidden="true" />
          <span>Loading scene</span>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="cube-map-viewer__status cube-map-viewer__status--error" role="alert">
          <AlertTriangle size={26} aria-hidden="true" />
          <span>{errorMessage || 'Unable to load scene'}</span>
        </div>
      ) : null}
    </div>
  );
}
