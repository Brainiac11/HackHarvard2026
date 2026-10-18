// Sky geometry and the star catalogue. Pure math (no DOM, no GPU), so it is unit-tested in Node.
import * as THREE from "three";
import { mulberry32 } from "./detail";

const DEG = Math.PI / 180;

/** Unit direction for a compass azimuth (deg; 0 = grid north = -z, 90 = east = +x) and elevation (deg). */
export function azEl(azDeg: number, elDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const az = azDeg * DEG, el = elDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/**
 * World -> galactic rotation (rows: toward the galactic centre, 90° along the plane, north galactic pole). The plane
 * crosses the horizon at azimuth `poleAz` ± 90°; the centre sits `centerDeg` along the plane from the crossing at
 * `poleAz` + 90°, measured upward.
 */
export function galacticFrame(poleAz: number, poleEl: number, centerDeg: number): THREE.Matrix3 {
  const pole = azEl(poleAz, poleEl);
  const node = azEl(poleAz + 90, 0);
  const rise = new THREE.Vector3().crossVectors(pole, node);
  if (rise.y < 0) rise.negate();
  const center = node.multiplyScalar(Math.cos(centerDeg * DEG)).addScaledVector(rise, Math.sin(centerDeg * DEG));
  const y = new THREE.Vector3().crossVectors(pole, center);
  return new THREE.Matrix3().set(
    center.x, center.y, center.z,
    y.x, y.y, y.z,
    pole.x, pole.y, pole.z,
  );
}

/** Approximate linear RGB of a blackbody at `kelvin`, brightest channel = 1 (Helland's fit, sRGB-decoded). */
export function blackbody(kelvin: number): [number, number, number] {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = [r, g, b].map((c) => (Math.min(255, Math.max(0, c)) / 255) ** 2.2);
  const max = Math.max(...lin);
  return [lin[0] / max, lin[1] / max, lin[2] / max];
}

/** Effective temperature from the B-V colour index (Ballesteros 2012). */
export const bvToKelvin = (bv: number) => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

export interface StarCatalog {
  count: number;
  dir: Float32Array; // unit vectors, world frame
  mag: Float32Array; // apparent visual magnitude
  color: Float32Array; // linear RGB, brightest channel 1, desaturated toward white as the eye sees it
}

export interface StarOptions {
  /** Stars over the whole sphere; only those above `minElevationDeg` are kept. */
  count: number;
  faintest: number;
  brightest: number;
  minElevationDeg: number;
  /** Share of stars crowded toward the galactic plane (and a little toward the bulge). */
  planeShare: number;
  seed: number;
}

/**
 * A synthetic sky with the real sky's statistics: star counts grow ~3.2x per magnitude (N(<m) ∝ 10^(0.5 m), about
 * 16 stars brighter than m = 1 and 5000 brighter than m = 6 over the whole sky), most stars are F-K (B-V ~ 0.6,
 * yellow-white), a few are blue-white or orange-red, and they crowd toward the Milky Way.
 */
export function starCatalog(galactic: THREE.Matrix3, o: StarOptions): StarCatalog {
  const rnd = mulberry32(o.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const toWorld = galactic.clone().transpose(); // rotation: inverse = transpose
  const minY = Math.sin(o.minElevationDeg * DEG);
  const dir: number[] = [], mag: number[] = [], color: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < o.count; i++) {
    const r = rnd();
    if (r < o.planeShare) {
      // galactic coordinates: latitude ~ N(0, 12°) in the disc, a rounder cloud around the centre for the bulge
      const bulge = r < o.planeShare * 0.2;
      const l = bulge ? gauss() * 18 * DEG : (rnd() * 2 - 1) * Math.PI;
      const b = gauss() * (bulge ? 10 : 12) * DEG;
      v.set(Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)).applyMatrix3(toWorld);
    } else {
      const u = rnd() * 2 - 1, th = rnd() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
      v.set(s * Math.cos(th), u, s * Math.sin(th));
    }
    // inverse of the cumulative count above, clamped at the brightest star we allow
    const m = Math.max(o.brightest, o.faintest + 2 * Math.log10(1 - rnd()));
    if (v.y < minY) continue;
    const [cr, cg, cb] = blackbody(bvToKelvin(THREE.MathUtils.clamp(0.6 + 0.42 * gauss(), -0.3, 1.9)));
    const sat = 0.55; // the dark-adapted eye sees star colours only faintly
    dir.push(v.x, v.y, v.z);
    mag.push(m);
    color.push(1 + (cr - 1) * sat, 1 + (cg - 1) * sat, 1 + (cb - 1) * sat);
  }
  return { count: mag.length, dir: new Float32Array(dir), mag: new Float32Array(mag), color: new Float32Array(color) };
}

/**
 * Shift `p` inside the plane of the light-space axes `x`, `y` so it lands on whole shadow-map texels. With the shadow
 * box centred there, a texel keeps covering the same patch of ground while the box follows the player, so shadow
 * edges don't crawl.
 */
export function snapToTexels(p: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, texelX: number, texelY: number):
    THREE.Vector3 {
  const px = p.dot(x), py = p.dot(y);
  return p.addScaledVector(x, Math.round(px / texelX) * texelX - px)
    .addScaledVector(y, Math.round(py / texelY) * texelY - py);
}
