# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "rasterio>=1.3",
#   "pyproj>=3.6",
#   "numpy>=1.26",
#   "scipy>=1.11",
#   "pillow>=10",
#   "httpx>=0.27",
# ]
# ///
"""Build the simulator terrain from NASA LOLA 5 m/px south-pole site DEMs.

Source: NASA GSFC PGDA "High-Resolution LOLA Topography for Lunar South Pole Sites"
https://pgda.gsfc.nasa.gov/products/78  (Barker et al. 2021, doi:10.1016/j.pss.2020.105119)

Usage:
    uv run terrain/build.py --site Site04
    uv run terrain/build.py --site Site04 --window 1200,900 --size 256

Outputs (sim/public/terrain/<site>/):
    height.f32   Float32 LE, row-major, metres above crop minimum
    slope.f32    Float32 LE, LOLA slope (deg), resampled to the same grid
    slperr.f32   Float32 LE, LOLA slope 1-sigma uncertainty (deg)
    cover.u8     uint8, LOLA laser returns per source pixel (0 = interpolated)
    albedo.png   2048x2048 surface texture
    overview.png full-site shaded relief with the crop outlined (minimap)
    meta.json    grid geometry, georeference, provenance
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import rasterio
from PIL import Image, ImageDraw
from pyproj import CRS, Transformer
from scipy import ndimage

BASE_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp"
SITE_NAMES = {
    "Site01": "Connecting ridge",
    "Site04": "Shackleton rim",
    "Site07": "Peak near Shackleton",
    "Site11": "de Gerlache rim",
    "Site20": "Leibnitz beta plateau",
    "Site23": "Malapert massif",
}
LAYERS = {"surf": "height", "slp": "slope", "slperr": "slope_err", "ldec": "count"}
MOON_RADIUS_M = 1737400.0
SOUTH_POLAR_STEREO = CRS.from_proj4(
    f"+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R={MOON_RADIUS_M} +units=m +no_defs"
)
MOON_LONGLAT = CRS.from_proj4(f"+proj=longlat +R={MOON_RADIUS_M} +no_defs")
CITATION = (
    "Barker, M. K., et al. (2021). Improved LOLA elevation maps for south pole landing sites: "
    "Error estimates and their impact on illumination conditions. Planetary & Space Science, "
    "203, 105119. doi:10.1016/j.pss.2020.105119"
)

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "terrain" / "raw"
OUT_ROOT = ROOT / "sim" / "public" / "terrain"


def download(site: str) -> dict[str, Path]:
    """Download the four rasters for a site (skips files already present with the right size)."""
    paths: dict[str, Path] = {}
    site_dir = RAW_DIR / site
    site_dir.mkdir(parents=True, exist_ok=True)
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=300.0)) as client:
        for layer in LAYERS:
            name = f"{site}_final_adj_5mpp_{layer}.tif"
            url = f"{BASE_URL}/{site}/{name}"
            dest = site_dir / name
            expected = int(client.head(url).headers.get("content-length", -1))
            if dest.exists() and dest.stat().st_size == expected:
                print(f"  cached   {name}")
            else:
                print(f"  download {name} ({expected / 1e6:.1f} MB)")
                tmp = dest.with_suffix(".part")
                with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    with tmp.open("wb") as fh:
                        for chunk in resp.iter_bytes(1 << 20):
                            fh.write(chunk)
                if expected > 0 and tmp.stat().st_size != expected:
                    raise RuntimeError(f"size mismatch for {name}")
                tmp.replace(dest)
            paths[layer] = dest
    return paths


def read_layers(paths: dict[str, Path]) -> tuple[dict[str, np.ndarray], rasterio.Affine, CRS]:
    arrays: dict[str, np.ndarray] = {}
    transform = None
    crs = None
    shape = None
    for layer, path in paths.items():
        with rasterio.open(path) as ds:
            data = ds.read(1).astype(np.float32)
            if ds.nodata is not None:
                data[data == ds.nodata] = np.nan
            data[~np.isfinite(data)] = np.nan
            arrays[layer] = data
            if transform is None:
                transform, shape = ds.transform, ds.shape
                crs = CRS.from_user_input(ds.crs) if ds.crs else SOUTH_POLAR_STEREO
            elif ds.shape != shape:
                raise RuntimeError(f"{layer} shape {ds.shape} != {shape}")
            print(f"  {layer:7s} {ds.shape[1]}x{ds.shape[0]} px  res={ds.res}  "
                  f"range=[{np.nanmin(data):.2f}, {np.nanmax(data):.2f}]")
    return arrays, transform, crs


def pick_window(slope: np.ndarray, count: np.ndarray, height: np.ndarray, size: int,
                stride: int) -> tuple[int, int, dict]:
    """Choose a drivable-but-interesting crop: maximise slope variety under safety constraints."""
    rows, cols = slope.shape
    candidates = []
    for y0 in range(0, rows - size + 1, stride):
        for x0 in range(0, cols - size + 1, stride):
            s = slope[y0:y0 + size, x0:x0 + size]
            h = height[y0:y0 + size, x0:x0 + size]
            if np.isnan(h).mean() > 0.001 or np.isnan(s).mean() > 0.001:
                continue
            c = count[y0:y0 + size, x0:x0 + size]
            stats = {
                "median_slope": float(np.nanmedian(s)),
                "steep_frac": float(np.nanmean(s > 25)),
                "warn_frac": float(np.nanmean(s > 15)),
                "coverage": float(np.nanmean(c >= 1)),
                "slope_std": float(np.nanstd(s)),
                "relief_m": float(np.nanmax(h) - np.nanmin(h)),
            }
            candidates.append((x0, y0, stats))
    if not candidates:
        raise RuntimeError("no fully valid window found; pass --window explicitly")

    def ok(st: dict, relax: float) -> bool:
        # drivable overall (warning zones are islands, not the whole map) but with real features
        return (st["median_slope"] < 7 * relax and st["steep_frac"] < 0.02 * relax
                and 0.04 / relax < st["warn_frac"] < 0.18 * relax
                and st["relief_m"] < 120 * relax and st["coverage"] > 0.05 / relax)

    for relax in (1.0, 1.5, 2.5, 100.0):
        passing = [c for c in candidates if ok(c[2], relax)]
        if passing:
            x0, y0, st = max(passing, key=lambda c: c[2]["slope_std"])
            st["relaxation"] = relax
            st["candidates_considered"] = len(candidates)
            return x0, y0, st
    raise AssertionError("unreachable")


def resample(arr: np.ndarray, n: int, order: int) -> np.ndarray:
    """Resample a square source window onto an n x n vertex grid spanning the same extent."""
    src = arr.shape[0]
    coords = np.linspace(0, src - 1, n, dtype=np.float64)
    yy, xx = np.meshgrid(coords, coords, indexing="ij")
    filled = arr
    if np.isnan(arr).any():
        idx = ndimage.distance_transform_edt(np.isnan(arr), return_distances=False, return_indices=True)
        filled = arr[tuple(idx)]
    return ndimage.map_coordinates(filled, [yy, xx], order=order, mode="nearest").astype(np.float32)


def hillshade(height: np.ndarray, spacing: float, azimuth_deg: float, altitude_deg: float) -> np.ndarray:
    dy, dx = np.gradient(height, spacing)
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az = np.radians(360.0 - azimuth_deg + 90.0)
    alt = np.radians(altitude_deg)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(shade, 0, 1)


def make_albedo(height: np.ndarray, slope: np.ndarray, spacing: float, size: int, seed: int) -> Image.Image:
    """Regolith albedo: soft multi-directional relief (ambient-occlusion feel) + slope + grain.

    Kept low-contrast because the simulator adds real-time low-sun lighting on top.
    """
    relief = np.mean([hillshade(height, spacing, az, 35) for az in (0, 90, 180, 270)], axis=0)
    curvature = ndimage.laplace(ndimage.gaussian_filter(height, 2.0))
    cavity = np.clip(0.5 - curvature * 4.0, 0, 1)
    fresh = np.clip((slope - 8) / 25, 0, 1)  # steeper walls expose brighter, less weathered material
    base = 0.42 + 0.18 * (relief - relief.mean()) + 0.08 * (cavity - 0.5) + 0.10 * fresh
    img = Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8), "L").resize((size, size), Image.BICUBIC)
    rng = np.random.default_rng(seed)
    grain = rng.normal(0, 6, (size, size))
    grain = ndimage.gaussian_filter(grain, 0.8)
    out = np.clip(np.asarray(img, dtype=np.float32) + grain, 0, 255).astype(np.uint8)
    tint = np.stack([out * 1.00, out * 0.98, out * 0.95], axis=-1)  # faint warm grey
    return Image.fromarray(np.clip(tint, 0, 255).astype(np.uint8), "RGB")


def make_overview(height: np.ndarray, window: tuple[int, int, int], size: int = 512) -> tuple[Image.Image, list]:
    h = height.copy()
    if np.isnan(h).any():
        h[np.isnan(h)] = np.nanmin(h)
    shade = hillshade(h, 5.0, 315, 20)
    img = Image.fromarray((shade * 255).astype(np.uint8), "L").convert("RGB")
    scale = size / max(img.size)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.BILINEAR)
    x0, y0, n = window
    box = [x0 * scale, y0 * scale, (x0 + n) * scale, (y0 + n) * scale]
    ImageDraw.Draw(img).rectangle(box, outline=(255, 170, 40), width=2)
    return img, [round(v / size, 5) for v in (box[0], box[1], box[2], box[3])]


def georeference(transform: rasterio.Affine, crs: CRS, x0: int, y0: int, n: int) -> dict:
    to_ll = Transformer.from_crs(crs, MOON_LONGLAT, always_xy=True)
    corners = {}
    for name, (col, row) in {"nw": (x0, y0), "ne": (x0 + n - 1, y0),
                             "sw": (x0, y0 + n - 1), "se": (x0 + n - 1, y0 + n - 1),
                             "center": (x0 + (n - 1) / 2, y0 + (n - 1) / 2)}.items():
        # pixel-centre coordinates (GMT pixel registration per the PGDA README)
        x, y = transform * (col + 0.5, row + 0.5)
        lon, lat = to_ll.transform(x, y)
        corners[name] = {"x_m": round(x, 2), "y_m": round(y, 2), "lat": round(lat, 6), "lon": round(lon % 360, 6)}
    return corners


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="Site04", choices=sorted(SITE_NAMES))
    ap.add_argument("--size", type=int, default=256, help="crop size in source pixels (5 m each)")
    ap.add_argument("--stride", type=int, default=32)
    ap.add_argument("--window", help="explicit crop origin 'x0,y0' in source pixels")
    ap.add_argument("--grid", type=int, default=1025, help="output vertices per side")
    ap.add_argument("--albedo", type=int, default=2048)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    print(f"[1/6] Downloading {args.site} ({SITE_NAMES[args.site]})")
    paths = download(args.site)

    print("[2/6] Reading rasters")
    arrays, transform, crs = read_layers(paths)
    height, slope, slperr, count = arrays["surf"], arrays["slp"], arrays["slperr"], arrays["ldec"]
    src_res = abs(transform.a)

    print("[3/6] Choosing crop window")
    if args.window:
        x0, y0 = (int(v) for v in args.window.split(","))
        stats = {"manual": True}
    else:
        x0, y0, stats = pick_window(slope, np.nan_to_num(count), height, args.size, args.stride)
    n = args.size
    print(f"  window x0={x0} y0={y0} size={n}px ({n * src_res:.0f} m)  stats={stats}")

    crop = {k: v[y0:y0 + n, x0:x0 + n] for k, v in arrays.items()}

    print("[4/6] Resampling to simulator grid")
    g = args.grid
    spacing = (n - 1) * src_res / (g - 1)
    h_grid = resample(crop["surf"], g, order=3)
    s_grid = resample(crop["slp"], g, order=1)
    e_grid = resample(crop["slperr"], g, order=1)
    c_grid = np.clip(np.nan_to_num(resample(crop["ldec"], g, order=0)), 0, 255).astype(np.uint8)
    elev_offset = float(h_grid.min())
    h_grid -= elev_offset

    # sanity checks (fail loudly rather than ship a broken terrain)
    for name, arr in (("height", h_grid), ("slope", s_grid), ("slope_err", e_grid)):
        assert np.isfinite(arr).all(), f"{name} has non-finite values"
    assert 0 <= float(s_grid.min()) and float(s_grid.max()) < 60, "implausible slope range"

    print("[5/6] Georeferencing")
    corners = georeference(transform, crs, x0, y0, n)
    assert all(-90 <= c["lat"] <= -80 for c in corners.values()), f"latitudes off: {corners}"

    print("[6/6] Writing outputs")
    out = OUT_ROOT / args.site.lower()
    out.mkdir(parents=True, exist_ok=True)
    h_grid.astype("<f4").tofile(out / "height.f32")
    s_grid.astype("<f4").tofile(out / "slope.f32")
    e_grid.astype("<f4").tofile(out / "slperr.f32")
    c_grid.tofile(out / "cover.u8")
    make_albedo(h_grid, s_grid, spacing, args.albedo, args.seed).save(out / "albedo.png", optimize=True)
    overview, overview_box = make_overview(height, (x0, y0, n))
    overview.save(out / "overview.png", optimize=True)

    meta = {
        "site": args.site,
        "site_name": SITE_NAMES[args.site],
        "grid": g,
        "spacing_m": round(spacing, 6),
        "extent_m": round(spacing * (g - 1), 3),
        "elev_offset_m": round(elev_offset, 3),
        "height_range_m": round(float(h_grid.max()), 3),
        "slope_range_deg": [round(float(s_grid.min()), 2), round(float(s_grid.max()), 2)],
        "coverage_fraction": round(float((c_grid >= 1).mean()), 4),
        "row_order": "north-to-south rows as in the source raster (row 0 = top of the GeoTIFF)",
        "corners": corners,
        "src": {
            "window_px": [x0, y0, n],
            "resolution_m": src_res,
            "raster_px": [int(height.shape[1]), int(height.shape[0])],
            "crs": crs.to_proj4() if hasattr(crs, "to_proj4") else str(crs),
            "window_stats": stats,
            "overview_box_uv": overview_box,
            "files": [f"{BASE_URL}/{args.site}/{p.name}" for p in paths.values()],
        },
        "provenance": {
            "dataset": "NASA GSFC PGDA — High-Resolution LOLA Topography for Lunar South Pole Sites (5 m/px)",
            "product_page": "https://pgda.gsfc.nasa.gov/products/78",
            "citation": CITATION,
            "notes": "Heights are LOLA-derived and interpolated where cover=0. Fine-scale detail added "
                     "in the simulator is synthetic and labelled as such.",
        },
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"  wrote {out.relative_to(ROOT)}  grid={g}  spacing={spacing:.3f} m  "
          f"relief={meta['height_range_m']} m  slope={meta['slope_range_deg']}  "
          f"coverage={meta['coverage_fraction']:.1%}  center={corners['center']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
