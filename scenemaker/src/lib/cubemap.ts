export const CUBE_FACE_KEYS = ['front', 'back', 'left', 'right', 'up', 'down'] as const;

export type CubeFaceKey = (typeof CUBE_FACE_KEYS)[number];

export type CubeFaceUrls = Record<CubeFaceKey, string>;

export type GeneratedPanoramaFaceKey = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

export type GeneratedPanoramaFaces = Record<GeneratedPanoramaFaceKey, string>;

export type GeneratedPanoramaCubemapResponse = {
  job_id: string;
  panoramaId?: string;
  panorama?: string;
  faces: GeneratedPanoramaFaces;
};

export type CubeFaceRotation = 0 | 90 | 180 | 270;

export type CubeFaceTransforms = Record<CubeFaceKey, CubeFaceRotation>;

export const DEFAULT_CUBE_FACE_TRANSFORMS: CubeFaceTransforms = {
  front: 0,
  back: 0,
  left: 0,
  right: 0,
  up: 0,
  down: 0,
};

export const THREE_CUBE_FACE_ORDER = ['right', 'left', 'up', 'down', 'back', 'front'] as const;

export const DEFAULT_INITIAL_FOV = 75;
export const DEFAULT_MIN_FOV = 35;
export const DEFAULT_MAX_FOV = 95;
export const DEFAULT_PITCH_LIMIT = 85;

export function clamp(value: number, min: number, max: number) {
  if (min > max) {
    throw new Error(`Invalid clamp range: min ${min} is greater than max ${max}.`);
  }

  return Math.min(Math.max(value, min), max);
}

export function clampFov(value: number, minFov = DEFAULT_MIN_FOV, maxFov = DEFAULT_MAX_FOV) {
  return clamp(value, minFov, maxFov);
}

export function clampPitchDegrees(value: number, limit = DEFAULT_PITCH_LIMIT) {
  return clamp(value, -Math.abs(limit), Math.abs(limit));
}

export function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

export function validateCubeFaces(faces: Partial<CubeFaceUrls> | null | undefined): CubeFaceUrls {
  if (!faces) {
    throw new Error('Cube-map faces are required.');
  }

  const missing = CUBE_FACE_KEYS.filter((key) => !faces[key]);

  if (missing.length > 0) {
    throw new Error(`Missing cube-map face${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  }

  const invalid = CUBE_FACE_KEYS.filter((key) => {
    const value = faces[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (invalid.length > 0) {
    throw new Error(`Invalid cube-map face URL${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}.`);
  }

  return faces as CubeFaceUrls;
}

export function orderedCubeFaceUrls(faces: CubeFaceUrls) {
  const validFaces = validateCubeFaces(faces);
  return THREE_CUBE_FACE_ORDER.map((face) => validFaces[face]);
}

export function cubeFacesFromGeneratedPanorama(faces: Partial<GeneratedPanoramaFaces>): CubeFaceUrls {
  const required: GeneratedPanoramaFaceKey[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];
  const missing = required.filter((face) => {
    const value = faces[face];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Generated panorama is missing face${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
  }

  return {
    front: faces.front!,
    back: faces.back!,
    left: faces.left!,
    right: faces.right!,
    up: faces.top!,
    down: faces.bottom!,
  };
}
