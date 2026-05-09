import { describe, expect, it } from 'vitest';

import {
  clampFov,
  clampPitchDegrees,
  CubeFaceUrls,
  orderedCubeFaceUrls,
  THREE_CUBE_FACE_ORDER,
  validateCubeFaces,
} from './cubemap';

const faces: CubeFaceUrls = {
  front: '/front.png',
  back: '/back.png',
  left: '/left.png',
  right: '/right.png',
  up: '/up.png',
  down: '/down.png',
};

describe('cubemap helpers', () => {
  it('orders public face names for Three.js cube textures', () => {
    expect(THREE_CUBE_FACE_ORDER).toEqual(['right', 'left', 'up', 'down', 'back', 'front']);
    expect(orderedCubeFaceUrls(faces)).toEqual([
      '/right.png',
      '/left.png',
      '/up.png',
      '/down.png',
      '/back.png',
      '/front.png',
    ]);
  });

  it('rejects missing cube faces with useful errors', () => {
    expect(() => validateCubeFaces({ ...faces, up: undefined })).toThrow('Missing cube-map face: up');
  });

  it('clamps viewer pitch and field of view', () => {
    expect(clampPitchDegrees(120)).toBe(85);
    expect(clampPitchDegrees(-120)).toBe(-85);
    expect(clampFov(20, 35, 95)).toBe(35);
    expect(clampFov(120, 35, 95)).toBe(95);
    expect(clampFov(64, 35, 95)).toBe(64);
  });
});
