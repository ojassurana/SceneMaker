# SceneMaker 360

A browser-based cube-map viewer for fixed-position 360 look-around scenes. The app accepts six square cube-face image URLs and renders them in Three.js with drag, touch, wheel/pinch zoom, reset, autorotate, fullscreen, loading, and error states.

## Cube Face Contract

Provide six same-resolution square images from one shared viewpoint:

```ts
type CubeFaceUrls = {
  front: string;
  back: string;
  left: string;
  right: string;
  up: string;
  down: string;
};
```

`front` is the initial camera direction. The viewer renders the faces as explicit skybox planes so each face orientation is controlled directly. If you need raw `CubeTextureLoader` ordering, the helper returns:

```ts
['right', 'left', 'up', 'down', 'back', 'front']
```

## Local Demo

The repo includes two generated test sets:

- `public/cubemaps/provided` for the latest user-supplied cube-map set
- `public/cubemaps/real` for a real Schadowplatz panorama-derived cube map
- `public/cubemaps/demo` for the default atrium scene, including `source-panorama.png`
- `public/cubemaps/calibration` for orientation and seam checks

Regenerate them with:

```bash
npm run generate:assets
```

## Commands

```bash
npm install
npm run dev
npm run test
npm run build
npm run test:e2e
```

The E2E config uses the system Google Chrome channel to avoid requiring a Playwright-managed browser download.
