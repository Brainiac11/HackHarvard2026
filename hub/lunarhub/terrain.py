"""Hub-side access to the processed LOLA rasters (same files the simulator renders).

World convention shared with the simulator (sim/src/world/terrain.ts):
    x = col * spacing - extent / 2      (+x = grid east)
    z = row * spacing - extent / 2      (row 0 = top of the source raster = grid north = -z)
    heading_deg: 0 = grid north (-z), 90 = east (+x), clockwise
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Lookahead:
    distance_m: float
    max_slope_deg: float
    max_slope_err_deg: float
    at_distance_m: float  # where the max slope occurs
    max_cover: int  # LOLA returns in the steepest cell (0 = that slope is interpolated, not measured)


class TerrainGrid:
    def __init__(self, directory: Path) -> None:
        self.meta = json.loads((directory / "meta.json").read_text())
        n = self.meta["grid"]
        self.n = n
        self.spacing = float(self.meta["spacing_m"])
        self.extent = float(self.meta["extent_m"])
        self.height = np.fromfile(directory / "height.f32", "<f4").reshape(n, n)
        self.slope = np.fromfile(directory / "slope.f32", "<f4").reshape(n, n)
        self.slope_err = np.fromfile(directory / "slperr.f32", "<f4").reshape(n, n)
        self.cover = np.fromfile(directory / "cover.u8", "u1").reshape(n, n)

    @classmethod
    def try_load(cls, directory: Path) -> "TerrainGrid | None":
        try:
            return cls(directory)
        except (OSError, KeyError, ValueError):
            return None

    def _rc(self, x: float, z: float) -> tuple[float, float]:
        col = (x + self.extent / 2) / self.spacing
        row = (z + self.extent / 2) / self.spacing
        return min(max(row, 0.0), self.n - 1.0), min(max(col, 0.0), self.n - 1.0)

    def _bilinear(self, arr: np.ndarray, x: float, z: float) -> float:
        r, c = self._rc(x, z)
        r0, c0 = int(r), int(c)
        r1, c1 = min(r0 + 1, self.n - 1), min(c0 + 1, self.n - 1)
        fr, fc = r - r0, c - c0
        top = arr[r0, c0] * (1 - fc) + arr[r0, c1] * fc
        bot = arr[r1, c0] * (1 - fc) + arr[r1, c1] * fc
        return float(top * (1 - fr) + bot * fr)

    def inside(self, x: float, z: float) -> bool:
        half = self.extent / 2
        return -half <= x <= half and -half <= z <= half

    def sample(self, x: float, z: float) -> dict:
        r, c = self._rc(x, z)
        return {
            "elev_m": round(self._bilinear(self.height, x, z) + self.meta["elev_offset_m"], 2),
            "lola_slope_deg": round(self._bilinear(self.slope, x, z), 2),
            "lola_slope_err_deg": round(self._bilinear(self.slope_err, x, z), 2),
            "coverage": int(self.cover[int(round(r)), int(round(c))]),
        }

    def latlon(self, x: float, z: float) -> tuple[float, float]:
        """Bilinear interpolation of the corner coordinates (fine over a ~1.3 km crop)."""
        corners = self.meta["corners"]
        u = (x + self.extent / 2) / self.extent
        v = (z + self.extent / 2) / self.extent

        def lerp(key: str) -> float:
            nw, ne, sw, se = (corners[k][key] for k in ("nw", "ne", "sw", "se"))
            if key == "lon":  # unwrap around 0/360
                ref = nw
                nw, ne, sw, se = (ref + ((val - ref + 180) % 360 - 180) for val in (nw, ne, sw, se))
            top = nw * (1 - u) + ne * u
            bot = sw * (1 - u) + se * u
            return top * (1 - v) + bot * v

        return round(lerp("lat"), 6), round(lerp("lon") % 360, 6)

    def lookahead(self, x: float, z: float, heading_deg: float, distance_m: float = 50.0,
                  step_m: float = 5.0) -> Lookahead:
        h = math.radians(heading_deg)
        dx, dz = math.sin(h), -math.cos(h)
        best = (-1.0, 0.0, 0.0, 0)
        d = step_m
        while d <= distance_m + 1e-6:
            px, pz = x + dx * d, z + dz * d
            if not self.inside(px, pz):
                break
            s = self.sample(px, pz)
            if s["lola_slope_deg"] > best[0]:
                best = (s["lola_slope_deg"], s["lola_slope_err_deg"], d, s["coverage"])
            d += step_m
        if best[0] < 0:
            return Lookahead(distance_m, 0.0, 0.0, 0.0, 0)
        return Lookahead(distance_m, round(best[0], 1), round(best[1], 1), best[2], best[3])

    def provenance(self) -> dict:
        return {
            "site": f"{self.meta['site']} ({self.meta['site_name']})",
            "source": "NASA LOLA 5 m/px (Barker et al. 2021)",
            "spacing_m": self.spacing,
        }
