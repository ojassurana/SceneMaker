import { CubeFaceUrls } from '../lib/cubemap';

export type DemoScene = {
  id: 'provided' | 'real' | 'demo' | 'calibration';
  name: string;
  faces: CubeFaceUrls;
};

function cubeFacePath(scene: DemoScene['id'], face: keyof CubeFaceUrls) {
  const extension = scene === 'calibration' ? 'svg' : 'png';
  return `${import.meta.env.BASE_URL}cubemaps/${scene}/${face}.${extension}`;
}

function makeFaces(scene: DemoScene['id']): CubeFaceUrls {
  return {
    front: cubeFacePath(scene, 'front'),
    back: cubeFacePath(scene, 'back'),
    left: cubeFacePath(scene, 'left'),
    right: cubeFacePath(scene, 'right'),
    up: cubeFacePath(scene, 'up'),
    down: cubeFacePath(scene, 'down'),
  };
}

export const DEMO_SCENES: DemoScene[] = [
  {
    id: 'provided',
    name: 'Provided Set',
    faces: makeFaces('provided'),
  },
  {
    id: 'real',
    name: 'Schadowplatz',
    faces: makeFaces('real'),
  },
  {
    id: 'demo',
    name: 'Atrium',
    faces: makeFaces('demo'),
  },
  {
    id: 'calibration',
    name: 'Calibration',
    faces: makeFaces('calibration'),
  },
];
