import {
  CUBE_FACE_KEYS,
  CubeFaceKey,
  CubeFaceRotation,
  CubeFaceTransforms,
  CubeFaceUrls,
  DEFAULT_CUBE_FACE_TRANSFORMS,
  validateCubeFaces,
} from './cubemap';

type EdgeName = 'top' | 'right' | 'bottom' | 'left';

type EdgeSample = Array<[number, number, number]>;

type FaceEdgeSamples = Record<EdgeName, EdgeSample>;

type FaceSampleSet = Record<CubeFaceKey, FaceEdgeSamples>;

type Seam = {
  a: CubeFaceKey;
  aEdge: EdgeName;
  b: CubeFaceKey;
  bEdge: EdgeName;
};

export type CubeMapQaSeverity = 'pass' | 'warn' | 'fail';

export type CubeMapQaReport = {
  severity: CubeMapQaSeverity;
  score: number;
  dimensions: Record<CubeFaceKey, { width: number; height: number }>;
  transforms: CubeFaceTransforms;
  issues: string[];
  seamScores: Array<{ seam: string; score: number }>;
};

const ROTATIONS: CubeFaceRotation[] = [0, 90, 180, 270];
const SAMPLE_COUNT: number = 48;

const SEAMS: Seam[] = [
  { a: 'front', aEdge: 'right', b: 'right', bEdge: 'left' },
  { a: 'right', aEdge: 'right', b: 'back', bEdge: 'left' },
  { a: 'back', aEdge: 'right', b: 'left', bEdge: 'left' },
  { a: 'left', aEdge: 'right', b: 'front', bEdge: 'left' },
  { a: 'front', aEdge: 'top', b: 'up', bEdge: 'bottom' },
  { a: 'right', aEdge: 'top', b: 'up', bEdge: 'right' },
  { a: 'back', aEdge: 'top', b: 'up', bEdge: 'top' },
  { a: 'left', aEdge: 'top', b: 'up', bEdge: 'left' },
  { a: 'front', aEdge: 'bottom', b: 'down', bEdge: 'top' },
  { a: 'right', aEdge: 'bottom', b: 'down', bEdge: 'right' },
  { a: 'back', aEdge: 'bottom', b: 'down', bEdge: 'bottom' },
  { a: 'left', aEdge: 'bottom', b: 'down', bEdge: 'left' },
];

function isCubeFaceRotation(value: number): value is CubeFaceRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function rotateEdgeName(edge: EdgeName, rotation: CubeFaceRotation): EdgeName {
  const edgeOrder: EdgeName[] = ['top', 'right', 'bottom', 'left'];
  const offset = rotation / 90;
  const edgeIndex = edgeOrder.indexOf(edge);
  return edgeOrder[(edgeIndex - offset + edgeOrder.length) % edgeOrder.length];
}

function shouldReverseEdge(edge: EdgeName, rotation: CubeFaceRotation) {
  if (rotation === 0) {
    return false;
  }

  if (rotation === 90) {
    return edge === 'top' || edge === 'bottom';
  }

  if (rotation === 180) {
    return true;
  }

  return edge === 'right' || edge === 'left';
}

function edgeForRotation(samples: FaceEdgeSamples, edge: EdgeName, rotation: CubeFaceRotation) {
  const source = samples[rotateEdgeName(edge, rotation)];
  return shouldReverseEdge(edge, rotation) ? [...source].reverse() : source;
}

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function edgeScore(a: EdgeSample, b: EdgeSample) {
  let forward = 0;
  let reversed = 0;

  for (let index = 0; index < a.length; index += 1) {
    forward += distance(a[index], b[index]);
    reversed += distance(a[index], b[b.length - 1 - index]);
  }

  return Math.min(forward, reversed) / (a.length * 3 * 255);
}

function scoreTransforms(samples: FaceSampleSet, transforms: CubeFaceTransforms) {
  const seamScores = SEAMS.map((seam) => ({
    seam: `${seam.a}.${seam.aEdge}:${seam.b}.${seam.bEdge}`,
    score: edgeScore(
      edgeForRotation(samples[seam.a], seam.aEdge, transforms[seam.a]),
      edgeForRotation(samples[seam.b], seam.bEdge, transforms[seam.b]),
    ),
  }));

  const score = seamScores.reduce((sum, seam) => sum + seam.score, 0) / seamScores.length;
  return { score, seamScores };
}

function readPixel(data: ImageData, x: number, y: number): [number, number, number] {
  const index = (y * data.width + x) * 4;
  return [data.data[index], data.data[index + 1], data.data[index + 2]];
}

function sampleEdge(data: ImageData, edge: EdgeName): EdgeSample {
  const samples: EdgeSample = [];

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const t = SAMPLE_COUNT === 1 ? 0 : index / (SAMPLE_COUNT - 1);
    const x = Math.round(t * (data.width - 1));
    const y = Math.round(t * (data.height - 1));

    if (edge === 'top') {
      samples.push(readPixel(data, x, 0));
    } else if (edge === 'right') {
      samples.push(readPixel(data, data.width - 1, y));
    } else if (edge === 'bottom') {
      samples.push(readPixel(data, x, data.height - 1));
    } else {
      samples.push(readPixel(data, 0, y));
    }
  }

  return samples;
}

async function loadImage(url: string) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Unable to load ${url}`));
    image.src = url;
  });

  return image;
}

function sampleImage(image: HTMLImageElement): FaceEdgeSamples {
  const canvas = document.createElement('canvas');
  const width = Math.max(image.naturalWidth, 1);
  const height = Math.max(image.naturalHeight, 1);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    throw new Error('Could not create image analysis canvas.');
  }

  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);

  return {
    top: sampleEdge(data, 'top'),
    right: sampleEdge(data, 'right'),
    bottom: sampleEdge(data, 'bottom'),
    left: sampleEdge(data, 'left'),
  };
}

function findBestTransforms(samples: FaceSampleSet) {
  let bestTransforms = DEFAULT_CUBE_FACE_TRANSFORMS;
  let best = scoreTransforms(samples, bestTransforms);

  for (const front of ROTATIONS) {
    for (const back of ROTATIONS) {
      for (const left of ROTATIONS) {
        for (const right of ROTATIONS) {
          for (const up of ROTATIONS) {
            for (const down of ROTATIONS) {
              const candidate = { front, back, left, right, up, down };
              const result = scoreTransforms(samples, candidate);

              if (result.score < best.score) {
                bestTransforms = candidate;
                best = result;
              }
            }
          }
        }
      }
    }
  }

  return { transforms: bestTransforms, ...best };
}

export async function analyzeCubeMap(faces: CubeFaceUrls): Promise<CubeMapQaReport> {
  const validFaces = validateCubeFaces(faces);
  const loaded = await Promise.all(
    CUBE_FACE_KEYS.map(async (face) => {
      const image = await loadImage(validFaces[face]);
      return [face, image] as const;
    }),
  );
  const dimensions = Object.fromEntries(
    loaded.map(([face, image]) => [face, { width: image.naturalWidth, height: image.naturalHeight }]),
  ) as CubeMapQaReport['dimensions'];
  const samples = Object.fromEntries(
    loaded.map(([face, image]) => [face, sampleImage(image)]),
  ) as FaceSampleSet;
  const issues: string[] = [];
  const firstDimensions = dimensions.front;

  for (const face of CUBE_FACE_KEYS) {
    const dimension = dimensions[face];

    if (dimension.width !== dimension.height) {
      issues.push(`${face} is ${dimension.width}x${dimension.height}; cube faces should be square.`);
    }

    if (dimension.width !== firstDimensions.width || dimension.height !== firstDimensions.height) {
      issues.push(`${face} does not match the front face size.`);
    }
  }

  const best = findBestTransforms(samples);
  const worstSeam = Math.max(...best.seamScores.map((seam) => seam.score));
  let severity: CubeMapQaSeverity = 'pass';

  if (best.score > 0.2 || worstSeam > 0.32 || issues.length > 0) {
    severity = 'fail';
  } else if (best.score > 0.12 || worstSeam > 0.22 || Object.values(best.transforms).some((value) => value !== 0)) {
    severity = 'warn';
  }

  const rotationIssues = Object.entries(best.transforms)
    .filter((entry): entry is [CubeFaceKey, CubeFaceRotation] => isCubeFaceRotation(entry[1]) && entry[1] !== 0)
    .map(([face, rotation]) => `${face} is auto-rotated ${rotation}deg for cleaner seams.`);

  return {
    severity,
    score: best.score,
    dimensions,
    transforms: best.transforms,
    issues: [...issues, ...rotationIssues],
    seamScores: best.seamScores.sort((a, b) => b.score - a.score),
  };
}
