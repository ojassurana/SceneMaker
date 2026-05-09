import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const [sourceArg, outputArg, sizeArg = '1024'] = process.argv.slice(2);

if (!sourceArg || !outputArg) {
  throw new Error('Usage: node scripts/convert-equirect-to-cubemap.mjs <source.jpg> <output-dir> [face-size]');
}

const faceSize = Number(sizeArg);
if (!Number.isFinite(faceSize) || faceSize <= 0) {
  throw new Error(`Invalid face size: ${sizeArg}`);
}

const sourcePath = path.resolve(sourceArg);
const outputDir = path.resolve(outputArg);
const source = jpeg.decode(await readFile(sourcePath), { useTArray: true });

function directionForCubeFace(face, x, y) {
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

function directionToEquirect([x, y, z]) {
  const yaw = Math.atan2(x, -z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, y)));
  const sourceX = ((yaw + Math.PI) / (Math.PI * 2)) * source.width;
  const sourceY = ((Math.PI / 2 - pitch) / Math.PI) * source.height;
  return [sourceX, sourceY];
}

function sourcePixel(x, y) {
  const wrappedX = ((x % source.width) + source.width) % source.width;
  const clampedY = Math.max(0, Math.min(source.height - 1, y));
  const index = (clampedY * source.width + wrappedX) * 4;
  return [
    source.data[index],
    source.data[index + 1],
    source.data[index + 2],
  ];
}

function bilinearSample(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = x - x0;
  const ty = y - y0;
  const p00 = sourcePixel(x0, y0);
  const p10 = sourcePixel(x1, y0);
  const p01 = sourcePixel(x0, y1);
  const p11 = sourcePixel(x1, y1);

  return [0, 1, 2].map((channel) => {
    const top = p00[channel] * (1 - tx) + p10[channel] * tx;
    const bottom = p01[channel] * (1 - tx) + p11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  });
}

function writePixel(image, x, y, color) {
  const index = (image.width * y + x) << 2;
  image.data[index] = color[0];
  image.data[index + 1] = color[1];
  image.data[index + 2] = color[2];
  image.data[index + 3] = 255;
}

await mkdir(outputDir, { recursive: true });

for (const face of ['front', 'back', 'left', 'right', 'up', 'down']) {
  const image = new PNG({ width: faceSize, height: faceSize });

  for (let y = 0; y < faceSize; y += 1) {
    for (let x = 0; x < faceSize; x += 1) {
      writePixel(image, x, y, bilinearSample(...directionToEquirect(directionForCubeFace(face, x, y))));
    }
  }

  await writeFile(path.join(outputDir, `${face}.png`), PNG.sync.write(image));
}

console.log(`Converted ${source.width}x${source.height} panorama into ${faceSize}px cube faces at ${outputDir}`);
