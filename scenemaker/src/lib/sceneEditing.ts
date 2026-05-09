import { CubeFaceKey, CubeFaceUrls, CUBE_FACE_KEYS, clampPitchDegrees } from './cubemap';

export type SceneEditStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'planning'
  | 'editing'
  | 'validating'
  | 'ready'
  | 'failed';

export type SceneEditTarget = {
  yaw: number;
  pitch: number;
  radiusDegrees: number;
};

export type SceneEditAffectedFace = {
  face: CubeFaceKey;
  maskPngBase64: string;
  compositeMaskPngBase64?: string;
  generationMaskPngBase64?: string;
  editRole: 'primary' | 'adjacent';
};

export type SceneEditPlan = {
  transcript: string;
  instruction: string;
  scope: 'localized';
  maskMode?: 'box' | 'user-refined';
  targetDescription?: string;
  preservationInstruction?: string;
  forbiddenChanges?: string[];
  successCriteria?: string;
  target: SceneEditTarget;
  affectedFaces: SceneEditAffectedFace[];
};

export type SceneEditResultPayload = {
  faces: CubeFaceUrls;
  panoramaId?: string;
  generatedFaces?: Partial<CubeFaceUrls>;
  editedFaces: CubeFaceKey[];
};

export type SceneEditVerification = {
  insideChange: number;
  outsideChange: number;
  warnings: string[];
};

export type SceneEditPreview = {
  faces: CubeFaceUrls;
  generatedFaces: Partial<CubeFaceUrls>;
  editedFaces: CubeFaceKey[];
  verification: SceneEditVerification;
};

export type SceneEditSelectionImage = {
  face: CubeFaceKey;
  imageDataUrl: string;
};

export type SceneEditAiVerification = {
  pass: boolean;
  confidence: number;
  reason: string;
  warnings: string[];
};

export type CubeFacePayloads = Record<CubeFaceKey, string>;

export type CubeProjection = {
  face: CubeFaceKey;
  u: number;
  v: number;
};

export type FaceSelectionRegion = {
  face: CubeFaceKey;
  points: Array<{ u: number; v: number }>;
};

export type SceneSelectionRegion = {
  source: 'box';
  faces: FaceSelectionRegion[];
  center: SceneEditTarget;
  box: { left: number; top: number; width: number; height: number };
  pose: ViewPose;
  aspect: number;
};

export type ViewPose = {
  yaw: number;
  pitch: number;
  fov: number;
};

export const DEFAULT_EDIT_RADIUS_DEGREES = 18;
export const PROTECTED_SEAM_RATIO = 0.08;

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

export function viewPoseToDirection(target: Pick<SceneEditTarget, 'yaw' | 'pitch'>) {
  const yaw = degreesToRadians(target.yaw);
  const pitch = degreesToRadians(clampPitchDegrees(target.pitch));
  const cosPitch = Math.cos(pitch);

  return {
    x: Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

export function screenPointToDirection(point: { x: number; y: number }, pose: ViewPose, aspect: number) {
  const yaw = degreesToRadians(pose.yaw);
  const pitch = degreesToRadians(clampPitchDegrees(pose.pitch));
  const tanHalfFov = Math.tan(degreesToRadians(pose.fov) / 2);
  const cameraX = point.x * aspect * tanHalfFov;
  const cameraY = -point.y * tanHalfFov;
  const cameraZ = -1;
  const length = Math.hypot(cameraX, cameraY, cameraZ);
  const local = {
    x: cameraX / length,
    y: cameraY / length,
    z: cameraZ / length,
  };
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const pitched = {
    x: local.x,
    y: local.y * cosPitch - local.z * sinPitch,
    z: local.y * sinPitch + local.z * cosPitch,
  };
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);

  return {
    x: pitched.x * cosYaw - pitched.z * sinYaw,
    y: pitched.y,
    z: pitched.x * sinYaw + pitched.z * cosYaw,
  };
}

export function directionToYawPitch(direction: { x: number; y: number; z: number }): Pick<SceneEditTarget, 'yaw' | 'pitch'> {
  const length = Math.max(Math.hypot(direction.x, direction.y, direction.z), 0.0001);
  return {
    yaw: normalizeYaw(Math.atan2(direction.x, -direction.z) * (180 / Math.PI)),
    pitch: clampPitchDegrees(Math.asin(direction.y / length) * (180 / Math.PI)),
  };
}

export function cubeProjectionToDirection(face: CubeFaceKey, u: number, v: number) {
  const a = u * 2 - 1;
  const b = 1 - v * 2;

  if (face === 'front') {
    return { x: a, y: b, z: -1 };
  }

  if (face === 'right') {
    return { x: 1, y: b, z: a };
  }

  if (face === 'back') {
    return { x: -a, y: b, z: 1 };
  }

  if (face === 'left') {
    return { x: -1, y: b, z: -a };
  }

  if (face === 'up') {
    return { x: a, y: 1, z: v * 2 - 1 };
  }

  return { x: a, y: -1, z: 1 - v * 2 };
}

export function directionToScreenPoint(direction: { x: number; y: number; z: number }, pose: ViewPose, aspect: number) {
  const yaw = degreesToRadians(pose.yaw);
  const pitch = degreesToRadians(clampPitchDegrees(pose.pitch));
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const yawed = {
    x: direction.x * cosYaw + direction.z * sinYaw,
    y: direction.y,
    z: -direction.x * sinYaw + direction.z * cosYaw,
  };
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const local = {
    x: yawed.x,
    y: yawed.y * cosPitch + yawed.z * sinPitch,
    z: -yawed.y * sinPitch + yawed.z * cosPitch,
  };

  if (local.z >= -0.0001) {
    return null;
  }

  const tanHalfFov = Math.tan(degreesToRadians(pose.fov) / 2);

  return {
    x: local.x / (-local.z * aspect * tanHalfFov),
    y: -local.y / (-local.z * tanHalfFov),
  };
}

export function directionToCubeProjection(direction: { x: number; y: number; z: number }): CubeProjection {
  const absX = Math.abs(direction.x);
  const absY = Math.abs(direction.y);
  const absZ = Math.abs(direction.z);

  if (absX >= absY && absX >= absZ) {
    if (direction.x >= 0) {
      return {
        face: 'right',
        u: clamp01((direction.z / absX + 1) / 2),
        v: clamp01((1 - direction.y / absX) / 2),
      };
    }

    return {
      face: 'left',
      u: clamp01((1 - direction.z / absX) / 2),
      v: clamp01((1 - direction.y / absX) / 2),
    };
  }

  if (absY >= absX && absY >= absZ) {
    if (direction.y >= 0) {
      return {
        face: 'up',
        u: clamp01((direction.x / absY + 1) / 2),
        v: clamp01((direction.z / absY + 1) / 2),
      };
    }

    return {
      face: 'down',
      u: clamp01((direction.x / absY + 1) / 2),
      v: clamp01((1 - direction.z / absY) / 2),
    };
  }

  if (direction.z >= 0) {
    return {
      face: 'back',
      u: clamp01((1 - direction.x / absZ) / 2),
      v: clamp01((1 - direction.y / absZ) / 2),
    };
  }

  return {
    face: 'front',
    u: clamp01((direction.x / absZ + 1) / 2),
    v: clamp01((1 - direction.y / absZ) / 2),
  };
}

export function projectViewPose(target: SceneEditTarget): CubeProjection {
  return directionToCubeProjection(viewPoseToDirection(target));
}

export function faceCenterYawPitch(face: CubeFaceKey) {
  if (face === 'front') {
    return { yaw: 0, pitch: 0 };
  }

  if (face === 'right') {
    return { yaw: 90, pitch: 0 };
  }

  if (face === 'back') {
    return { yaw: 180, pitch: 0 };
  }

  if (face === 'left') {
    return { yaw: -90, pitch: 0 };
  }

  if (face === 'up') {
    return { yaw: 0, pitch: 90 };
  }

  return { yaw: 0, pitch: -90 };
}

export function normalizeYaw(value: number) {
  let yaw = value % 360;

  if (yaw > 180) {
    yaw -= 360;
  } else if (yaw <= -180) {
    yaw += 360;
  }

  return yaw;
}

export function pickTargetFromTranscript(transcript: string, fallbackPose: ViewPose): SceneEditTarget {
  const normalized = transcript.toLowerCase();
  const face = CUBE_FACE_KEYS.find((candidate) => normalized.includes(candidate));

  if (face) {
    return {
      ...faceCenterYawPitch(face),
      radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES,
    };
  }

  if (normalized.includes('ceiling') || normalized.includes('sky') || normalized.includes('above')) {
    return { yaw: normalizeYaw(fallbackPose.yaw), pitch: 72, radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES };
  }

  if (normalized.includes('floor') || normalized.includes('ground') || normalized.includes('below')) {
    return { yaw: normalizeYaw(fallbackPose.yaw), pitch: -72, radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES };
  }

  if (normalized.includes('left')) {
    return { yaw: normalizeYaw(fallbackPose.yaw - 35), pitch: fallbackPose.pitch, radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES };
  }

  if (normalized.includes('right')) {
    return { yaw: normalizeYaw(fallbackPose.yaw + 35), pitch: fallbackPose.pitch, radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES };
  }

  return {
    yaw: normalizeYaw(fallbackPose.yaw),
    pitch: clampPitchDegrees(fallbackPose.pitch),
    radiusDegrees: DEFAULT_EDIT_RADIUS_DEGREES,
  };
}

export function getAdjacentFaces(projection: CubeProjection, seamRatio = PROTECTED_SEAM_RATIO): CubeFaceKey[] {
  const adjacent = new Set<CubeFaceKey>();

  if (projection.u <= seamRatio || projection.u >= 1 - seamRatio) {
    if (projection.face === 'front') {
      adjacent.add(projection.u <= seamRatio ? 'left' : 'right');
    } else if (projection.face === 'right') {
      adjacent.add(projection.u <= seamRatio ? 'front' : 'back');
    } else if (projection.face === 'back') {
      adjacent.add(projection.u <= seamRatio ? 'right' : 'left');
    } else if (projection.face === 'left') {
      adjacent.add(projection.u <= seamRatio ? 'back' : 'front');
    }
  }

  if (projection.v <= seamRatio) {
    adjacent.add('up');
  } else if (projection.v >= 1 - seamRatio) {
    adjacent.add('down');
  }

  if (projection.face === 'up' || projection.face === 'down') {
    if (projection.u <= seamRatio) {
      adjacent.add('left');
    } else if (projection.u >= 1 - seamRatio) {
      adjacent.add('right');
    }

    if (projection.v <= seamRatio) {
      adjacent.add(projection.face === 'up' ? 'back' : 'front');
    } else if (projection.v >= 1 - seamRatio) {
      adjacent.add(projection.face === 'up' ? 'front' : 'back');
    }
  }

  adjacent.delete(projection.face);
  return [...adjacent];
}

export function selectAffectedFaces(target: SceneEditTarget): Array<{ face: CubeFaceKey; editRole: 'primary' | 'adjacent' }> {
  const projection = projectViewPose(target);
  const radiusRatio = Math.min(Math.max(target.radiusDegrees / 90, 0.08), 0.36);
  const edgeDistance = Math.min(projection.u, 1 - projection.u, projection.v, 1 - projection.v);
  const touchesSeam = edgeDistance <= PROTECTED_SEAM_RATIO + radiusRatio * 0.35;
  const adjacentFaces = touchesSeam ? getAdjacentFaces(projection, PROTECTED_SEAM_RATIO + radiusRatio * 0.35) : [];

  return [
    { face: projection.face, editRole: 'primary' },
    ...adjacentFaces.map((face) => ({ face, editRole: 'adjacent' as const })),
  ];
}

export function selectionBoxToRegion(
  box: { left: number; top: number; width: number; height: number },
  pose: ViewPose,
  aspect: number,
  sampleCount = 7,
): SceneSelectionRegion {
  const projectionsByFace = new Map<CubeFaceKey, Array<{ u: number; v: number }>>();
  const centerDirection = screenPointToDirection(
    {
      x: (box.left + box.width / 2) * 2 - 1,
      y: (box.top + box.height / 2) * 2 - 1,
    },
    pose,
    aspect,
  );
  const center = directionToYawPitch(centerDirection);
  const radiusDegrees = Math.min(Math.max(Math.max(box.width, box.height) * pose.fov * 0.6, 8), 42);

  for (let yIndex = 0; yIndex < sampleCount; yIndex += 1) {
    for (let xIndex = 0; xIndex < sampleCount; xIndex += 1) {
      const xRatio = sampleCount === 1 ? 0.5 : xIndex / (sampleCount - 1);
      const yRatio = sampleCount === 1 ? 0.5 : yIndex / (sampleCount - 1);
      const point = {
        x: (box.left + box.width * xRatio) * 2 - 1,
        y: (box.top + box.height * yRatio) * 2 - 1,
      };
      const projection = directionToCubeProjection(screenPointToDirection(point, pose, aspect));
      const points = projectionsByFace.get(projection.face) ?? [];
      points.push({ u: projection.u, v: projection.v });
      projectionsByFace.set(projection.face, points);
    }
  }

  return {
    source: 'box',
    box,
    pose,
    aspect,
    center: {
      yaw: center.yaw,
      pitch: center.pitch,
      radiusDegrees,
    },
    faces: [...projectionsByFace.entries()].map(([face, points]) => ({ face, points })),
  };
}

export function createEditMaskSvg(face: CubeFaceKey, target: SceneEditTarget, size = 1024) {
  const projection = projectViewPose(target);
  const isPrimary = face === projection.face;
  const radius = Math.round(size * Math.min(Math.max(target.radiusDegrees / 90, 0.1), 0.35));
  const centerX = Math.round((isPrimary ? projection.u : 0.5) * size);
  const centerY = Math.round((isPrimary ? projection.v : 0.5) * size);
  const feather = Math.max(10, Math.round(radius * 0.18));
  const innerRadius = Math.max(1, radius - feather);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    '<rect width="100%" height="100%" fill="black"/>',
    '<defs>',
    '<radialGradient id="mask-feather">',
    `<stop offset="${innerRadius / radius}" stop-color="white"/>`,
    '<stop offset="1" stop-color="black"/>',
    '</radialGradient>',
    '</defs>',
    `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="url(#mask-feather)"/>`,
    '</svg>',
  ].join('');
}
