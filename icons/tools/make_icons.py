"""Crop the source renders to the icon tile and export PNG sizes plus .ico files."""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = [1024, 512, 256, 128, 64, 48, 32, 16]
ICO_SIZES = [256, 128, 64, 48, 32, 16]
SS = 4

SOURCES = [
    ("light", ROOT / "ChatGPT_xQBGv24GYc.png"),
    ("dark", ROOT / "ChatGPT_qPkaIrLGsm.png"),
]


def tile_mask(rgb):
    a = rgb.astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # Anything that is not the near-white page background belongs to the artwork.
    return (a.sum(2) < 748) | (np.abs(r - b) > 4) | (np.abs(g - b) > 4)


def tile_bbox(mask):
    cols = mask.sum(0)
    rows = mask.sum(1)
    xs = np.where(cols > cols.max() * 0.35)[0]
    ys = np.where(rows > rows.max() * 0.35)[0]
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    # The renders carry a drop shadow below the tile, so trust the width and
    # square the crop downward from the top edge.
    side = x1 - x0 + 1
    return x0, x1, y0, y0 + side - 1


def corner_radius(mask, x0, x1, y0, y1):
    ests = []
    for d in range(10, int((y1 - y0) * 0.18)):
        idx = np.where(mask[y0 + d, x0:x1 + 1])[0]
        if not len(idx) or idx.min() <= 0:
            continue
        x = float(idx.min())
        ests.append((d + x) + np.sqrt(2.0 * d * x))
    return float(np.median(ests)) if ests else (x1 - x0) * 0.21


def rounded_alpha(w, h, radius, size):
    n = size * SS
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    # Map supersampled pixel centres back onto the source tile grid.
    px = (xs + 0.5) / n * w
    py = (ys + 0.5) / n * h
    r = radius
    dx = np.clip(r - px, 0, None) + np.clip(px - (w - r), 0, None)
    dy = np.clip(r - py, 0, None) + np.clip(py - (h - r), 0, None)
    inside = (dx * dx + dy * dy) <= r * r
    cov = inside.reshape(size, SS, size, SS).mean((1, 3))
    return (cov * 255).round().astype(np.uint8)


def build(name, path):
    src = Image.open(path).convert("RGB")
    mask = tile_mask(np.asarray(src))
    x0, x1, y0, y1 = tile_bbox(mask)
    radius = corner_radius(mask, x0, x1, y0, y1)
    tile = src.crop((x0, y0, x1 + 1, y1 + 1))
    w, h = tile.size
    print(f"{name}: tile {w}x{h} radius {radius:.1f}")

    outdir = ROOT / "dist" / name
    outdir.mkdir(parents=True, exist_ok=True)

    frames = {}
    for size in SIZES:
        img = tile.resize((size, size), Image.LANCZOS).convert("RGBA")
        img.putalpha(Image.fromarray(rounded_alpha(w, h, radius, size), "L"))
        img.save(outdir / f"icon-{size}.png", optimize=True)
        frames[size] = img

    frames[1024].save(ROOT / "dist" / f"goodbuddy-{name}.ico", format="ICO",
                      sizes=[(s, s) for s in ICO_SIZES])
    return frames[512]


def main():
    previews = [build(n, p) for n, p in SOURCES]
    gap = 32
    sheet = Image.new("RGBA", (512 * 2 + gap * 3, 512 + gap * 2), (128, 128, 128, 255))
    for i, img in enumerate(previews):
        sheet.paste(img, (gap + i * (512 + gap), gap), img)
    sheet.save(ROOT / "dist" / "preview.png")


if __name__ == "__main__":
    main()
