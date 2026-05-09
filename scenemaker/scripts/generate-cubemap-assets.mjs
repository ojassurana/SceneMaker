import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const outDir = path.resolve('public/cubemaps');
const size = 1024;
const center = size / 2;

const faceNeighbors = {
  front: { left: 'LEFT', right: 'RIGHT', top: 'UP', bottom: 'DOWN' },
  right: { left: 'FRONT', right: 'BACK', top: 'UP', bottom: 'DOWN' },
  back: { left: 'RIGHT', right: 'LEFT', top: 'UP', bottom: 'DOWN' },
  left: { left: 'BACK', right: 'FRONT', top: 'UP', bottom: 'DOWN' },
  up: { left: 'LEFT', right: 'RIGHT', top: 'BACK', bottom: 'FRONT' },
  down: { left: 'LEFT', right: 'RIGHT', top: 'FRONT', bottom: 'BACK' },
};

const faceColors = {
  front: ['#225c83', '#f2c35b'],
  right: ['#256d67', '#ff8b6d'],
  back: ['#6a4f93', '#a7eadb'],
  left: ['#8d4e2f', '#58d6c7'],
  up: ['#2e6f9b', '#fffaf2'],
  down: ['#51412f', '#f2c35b'],
};

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function svgShell(title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  ${body}
</svg>
`;
}

function calibrationFace(face) {
  const [primary, secondary] = faceColors[face];
  const neighbors = faceNeighbors[face];
  const gridLines = Array.from({ length: 9 }, (_, index) => {
    const pos = 128 * index;
    const width = index === 4 ? 4 : 2;
    const opacity = index === 4 ? 0.7 : 0.35;
    return `
    <line x1="${pos}" y1="0" x2="${pos}" y2="${size}" stroke="#fffaf2" stroke-width="${width}" opacity="${opacity}"/>
    <line x1="0" y1="${pos}" x2="${size}" y2="${pos}" stroke="#fffaf2" stroke-width="${width}" opacity="${opacity}"/>`;
  }).join('');

  return svgShell(
    `Calibration cube face ${face}`,
    `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${primary}"/>
      <stop offset="100%" stop-color="${secondary}"/>
    </linearGradient>
    <pattern id="microGrid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#171411" stroke-width="1" opacity="0.26"/>
    </pattern>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <rect width="${size}" height="${size}" fill="url(#microGrid)"/>
  ${gridLines}
  <rect x="28" y="28" width="968" height="968" rx="0" fill="none" stroke="#171411" stroke-width="14" opacity="0.5"/>
  <rect x="48" y="48" width="928" height="928" rx="0" fill="none" stroke="#fffaf2" stroke-width="6" opacity="0.85"/>
  <text x="${center}" y="462" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="112" font-weight="900" fill="#fffaf2">${face.toUpperCase()}</text>
  <text x="${center}" y="548" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#171411">CUBE FACE</text>
  <text x="96" y="${center}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 96 ${center})" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="#fffaf2">← ${neighbors.left}</text>
  <text x="928" y="${center}" text-anchor="middle" dominant-baseline="middle" transform="rotate(90 928 ${center})" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="#fffaf2">${neighbors.right} →</text>
  <text x="${center}" y="108" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="#fffaf2">↑ ${neighbors.top}</text>
  <text x="${center}" y="940" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="#fffaf2">↓ ${neighbors.bottom}</text>
  <circle cx="${center}" cy="${center}" r="92" fill="#171411" opacity="0.78"/>
  <path d="M512 358L542 512L512 666L482 512Z" fill="#fffaf2"/>
`,
  );
}

async function writeCalibrationScene(faces) {
  const scene = 'calibration';
  const sceneDir = path.join(outDir, scene);
  await mkdir(sceneDir, { recursive: true });

  await Promise.all(
    faces.map((face) => {
      const svg = calibrationFace(face);
      return writeFile(path.join(sceneDir, `${face}.svg`), svg);
    }),
  );
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function mixColor(a, b, amount) {
  return [
    Math.round(lerp(a[0], b[0], amount)),
    Math.round(lerp(a[1], b[1], amount)),
    Math.round(lerp(a[2], b[2], amount)),
  ];
}

function smoothstep(edge0, edge1, value) {
  const x = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function stripe(value, frequency, width = 0.5) {
  return Math.abs((value * frequency) % 1) < width ? 1 : 0;
}

function directionForCubeFace(face, x, y, faceSize) {
  const u = (2 * (x + 0.5)) / faceSize - 1;
  const v = 1 - (2 * (y + 0.5)) / faceSize;
  const vectors = {
    front: [u, v, -1],
    back: [-u, v, 1],
    right: [1, v, u],
    left: [-1, v, -u],
    up: [u, 1, v],
    down: [u, -1, -v],
  };
  const vector = vectors[face];
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function directionForPanorama(x, y, width, height) {
  const yaw = (x / width) * Math.PI * 2 - Math.PI;
  const pitch = Math.PI / 2 - (y / height) * Math.PI;
  const cosPitch = Math.cos(pitch);

  return [
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    -Math.cos(yaw) * cosPitch,
  ];
}

function wallHit([x, y, z]) {
  if (Math.abs(z) >= Math.abs(x)) {
    const t = 1 / Math.abs(z);
    return {
      face: z < 0 ? 'front' : 'back',
      u: z < 0 ? x * t : -x * t,
      v: y * t,
    };
  }

  const t = 1 / Math.abs(x);
  return {
    face: x > 0 ? 'right' : 'left',
    u: x > 0 ? z * t : -z * t,
    v: y * t,
  };
}

function planeHit([x, y, z], planeY) {
  const t = planeY / y;
  return [x * t, z * t];
}

function sampleAtrium(direction) {
  const [x, y, z] = direction;

  if (y > 0.48) {
    const [px, pz] = planeHit(direction, 1);
    const skylight = Math.max(Math.abs(px), Math.abs(pz)) < 0.64;
    const panel = stripe(px + 10, 3.4, 0.08) || stripe(pz + 10, 3.4, 0.08);
    const base = mixColor([248, 242, 229], [208, 222, 214], smoothstep(0.48, 1, y));

    if (skylight) {
      const sky = mixColor([147, 217, 222], [242, 195, 91], smoothstep(-0.2, 0.7, pz));
      return panel ? mixColor(sky, [252, 250, 242], 0.78) : sky;
    }

    return panel ? mixColor(base, [166, 129, 86], 0.25) : base;
  }

  if (y < -0.38) {
    const [px, pz] = planeHit(direction, -1);
    const woodLine = stripe(px + pz * 0.2 + 20, 5.2, 0.07);
    const rugShape = px * px / 1.1 + pz * pz / 0.58 < 1;
    const rugCore = px * px / 0.54 + pz * pz / 0.25 < 1;
    let color = mixColor([129, 94, 58], [56, 39, 32], smoothstep(-0.38, -1, y));

    if (woodLine) {
      color = mixColor(color, [204, 155, 104], 0.35);
    }

    if (rugShape) {
      color = mixColor([242, 195, 91], [255, 139, 109], Math.abs(px) * 0.35);
    }

    if (rugCore) {
      color = mixColor(color, [88, 214, 199], 0.58);
    }

    return color;
  }

  const hit = wallHit(direction);
  const wallWarmth = smoothstep(-0.55, 0.7, hit.v);
  let color = mixColor([164, 98, 79], [248, 239, 224], wallWarmth);

  if (hit.v > 0.64) {
    color = mixColor(color, [248, 247, 238], 0.55);
  }

  if (Math.abs(hit.v + 0.2) < 0.02) {
    color = mixColor(color, [255, 244, 220], 0.72);
  }

  if (hit.face === 'front' && Math.abs(hit.u) < 0.44 && hit.v > 0.02 && hit.v < 0.58) {
    const windowU = (hit.u + 0.44) / 0.88;
    const windowV = (hit.v - 0.02) / 0.56;
    color = mixColor([156, 216, 221], [35, 99, 94], smoothstep(0.45, 1, windowV));

    if (windowV > 0.54 + Math.sin(windowU * Math.PI * 5) * 0.08) {
      color = [242, 195, 91];
    }

    if (Math.abs(hit.u) < 0.015 || Math.abs(hit.v - 0.3) < 0.018) {
      color = [85, 127, 138];
    }
  }

  if (hit.face === 'right' && Math.abs(hit.u) < 0.68 && hit.v > -0.04 && hit.v < 0.5) {
    const shelfIndex = Math.floor(((hit.u + 0.68) / 1.36) * 7);
    const palette = [
      [242, 195, 91],
      [88, 214, 199],
      [255, 250, 242],
      [255, 139, 109],
      [167, 234, 219],
      [96, 68, 53],
      [242, 195, 91],
    ];
    color = palette[Math.max(0, Math.min(palette.length - 1, shelfIndex))];

    if (Math.abs(((hit.v + 0.04) * 5) % 1) < 0.08) {
      color = mixColor(color, [45, 33, 28], 0.38);
    }
  }

  if (hit.face === 'back' && Math.abs(hit.u) < 0.28 && hit.v > -0.16 && hit.v < 0.7) {
    color = mixColor([47, 49, 48], [72, 103, 99], smoothstep(-0.16, 0.7, hit.v));

    if (Math.abs(hit.u) > 0.24 || Math.abs(hit.v - 0.7) < 0.025) {
      color = [81, 60, 52];
    }
  }

  if (hit.face === 'left' && Math.abs(hit.u) < 0.68 && hit.v > 0.02 && hit.v < 0.55) {
    const wave = Math.sin((hit.u + 0.68) * Math.PI * 3.2) * 0.12;
    const path = Math.abs(hit.v - 0.28 - wave);
    color = [50, 42, 36];

    if (path < 0.05) {
      color = path < 0.024 ? [88, 214, 199] : [242, 195, 91];
    }
  }

  return color;
}

function writePixel(image, x, y, color) {
  const index = (image.width * y + x) << 2;
  image.data[index] = color[0];
  image.data[index + 1] = color[1];
  image.data[index + 2] = color[2];
  image.data[index + 3] = 255;
}

async function writePng(filePath, image) {
  await writeFile(filePath, PNG.sync.write(image));
}

async function writeDemoPngScene() {
  const sceneDir = path.join(outDir, 'demo');
  await mkdir(sceneDir, { recursive: true });

  const faces = ['front', 'back', 'left', 'right', 'up', 'down'];
  await Promise.all(
    faces.map(async (face) => {
      const image = new PNG({ width: size, height: size });

      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          writePixel(image, x, y, sampleAtrium(directionForCubeFace(face, x, y, size)));
        }
      }

      await writePng(path.join(sceneDir, `${face}.png`), image);
    }),
  );

  const panoramaWidth = size * 2;
  const panorama = new PNG({ width: panoramaWidth, height: size });

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < panoramaWidth; x += 1) {
      writePixel(panorama, x, y, sampleAtrium(directionForPanorama(x, y, panoramaWidth, size)));
    }
  }

  await writePng(path.join(sceneDir, 'source-panorama.png'), panorama);
}

await writeCalibrationScene(['front', 'back', 'left', 'right', 'up', 'down']);
await writeDemoPngScene();

console.log(`Generated cube-map assets in ${outDir}`);
