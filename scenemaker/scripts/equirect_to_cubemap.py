#!/usr/bin/env python3
import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image


FACES = {
    "front": lambda x, y: (x, -y, 1),
    "right": lambda x, y: (1, -y, -x),
    "back": lambda x, y: (-x, -y, -1),
    "left": lambda x, y: (-1, -y, x),
    "top": lambda x, y: (x, 1, y),
    "bottom": lambda x, y: (x, -1, -y),
}


def sample_bilinear(img, u, v):
    h, w, _ = img.shape
    u = u % w
    v = np.clip(v, 0, h - 1)

    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    x1 = (x0 + 1) % w
    y1 = np.clip(y0 + 1, 0, h - 1)

    dx = (u - x0)[..., None]
    dy = (v - y0)[..., None]

    top = img[y0, x0] * (1 - dx) + img[y0, x1] * dx
    bottom = img[y1, x0] * (1 - dx) + img[y1, x1] * dx
    return top * (1 - dy) + bottom * dy


def make_face(img, face_name, size):
    coords = (np.arange(size, dtype=np.float32) + 0.5) / size * 2 - 1
    xx, yy = np.meshgrid(coords, coords)
    vx, vy, vz = FACES[face_name](xx, yy)
    norm = np.sqrt(vx * vx + vy * vy + vz * vz)
    vx, vy, vz = vx / norm, vy / norm, vz / norm

    lon = np.arctan2(vx, vz)
    lat = np.arcsin(vy)
    h, w, _ = img.shape
    u = (lon / (2 * math.pi) + 0.5) * w - 0.5
    v = (0.5 - lat / math.pi) * h - 0.5
    face = sample_bilinear(img, u, v)
    return Image.fromarray(np.clip(face, 0, 255).astype(np.uint8), "RGB")


def main():
    parser = argparse.ArgumentParser(description="Convert a 2:1 equirectangular panorama into six cubemap faces.")
    parser.add_argument("panorama", help="Input equirectangular panorama")
    parser.add_argument("--out-dir", default="cubemap", help="Output directory")
    parser.add_argument("--face-size", type=int, default=1024, help="Cube face size")
    args = parser.parse_args()

    pano = Image.open(args.panorama).convert("RGB")
    w, h = pano.size
    if abs((w / h) - 2.0) > 0.02:
        raise SystemExit(f"Expected a 2:1 panorama, got {w}x{h}.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    img = np.asarray(pano, dtype=np.float32)

    for face in ["front", "right", "back", "left", "top", "bottom"]:
        make_face(img, face, args.face_size).save(out_dir / f"{face}.png")

    print(f"Wrote cubemap faces to {out_dir}")


if __name__ == "__main__":
    main()
