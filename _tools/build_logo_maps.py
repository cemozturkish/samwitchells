#!/usr/bin/env python3
"""Build the textures the homepage shader needs from the logo artwork.

    python3 _tools/build_logo_maps.py            (needs pillow, numpy, scipy)

Reads  background.png        the logo render, RGBA, alpha = silhouette
Writes assets/logo.webp      the logo composited on black (also the no-WebGL fallback)
       assets/logo-relief.webp R,G = surface normal x,y   B = "is metal" mask
                               (lossless: lossy compression shows up as grit
                               in the reflections)

The artwork is a flat picture, so the 3D surface is reconstructed: every lit
piece of metal is inflated into a rounded relief, and the slope of that relief
is what the shader bounces light off. Re-run this whenever the logo changes.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
SIZE = (2048, 1024)  # power of two so every browser can mipmap it

src = Image.open(ROOT / "background.png").convert("RGBA").resize(SIZE, Image.LANCZOS)
rgba = np.asarray(src).astype(np.float64) / 255.0
alpha = rgba[..., 3]
rgb = rgba[..., :3] * alpha[..., None]  # composite on black
lum = rgb @ np.array([0.299, 0.587, 0.114])

# --- which pixels are metal (letter bodies + the barbed outline wire) -------
# The silhouette alpha also covers the black gaps between body and wire, so
# gate it with a slightly blurred luminance: chrome is never dark for long.
metal_bin = (ndi.gaussian_filter(lum, 1.7) > 0.08) & (alpha > 0.5)
metal_bin = ndi.binary_opening(metal_bin, iterations=1)
metal = ndi.gaussian_filter(metal_bin.astype(np.float64), 1.0)

# --- relief -----------------------------------------------------------------
# Multi-scale inflation: fine scales give the tight bevel on wires and edges,
# coarse scales dome the wide strokes so no part is perfectly flat.
m = metal_bin.astype(np.float64)
height = np.zeros_like(m)
for sigma, weight in ((1.6, 1.3), (4.0, 2.6), (9.0, 4.5), (20.0, 7.0)):
    height += weight * ndi.gaussian_filter(m, sigma)
# A little of the painted detail so highlights catch the ridges in the art.
height += 2.2 * ndi.gaussian_filter(lum, 1.3) * metal

gy, gx = np.gradient(height)
normal = np.dstack([-gx, -gy, np.ones_like(height)])
normal /= np.linalg.norm(normal, axis=2, keepdims=True)

# --- write ------------------------------------------------------------------
def to_u8(x):
    return np.clip(x * 255.0 + 0.5, 0, 255).astype(np.uint8)


relief = np.dstack([to_u8(normal[..., 0] * 0.5 + 0.5), to_u8(normal[..., 1] * 0.5 + 0.5), to_u8(metal)])
out = ROOT / "assets"
out.mkdir(exist_ok=True)
Image.fromarray(relief, "RGB").save(out / "logo-relief.webp", lossless=True, method=6)
Image.fromarray(to_u8(rgb), "RGB").save(out / "logo.webp", quality=93, method=6)

for name in ("logo.webp", "logo-relief.webp"):
    print(f"{name}: {(out / name).stat().st_size / 1024:.0f} KB")
print(f"steepest slope: {np.degrees(np.arccos(normal[..., 2].min())):.0f} deg, "
      f"median on metal: {np.degrees(np.arccos(np.median(normal[..., 2][metal_bin]))):.0f} deg")
