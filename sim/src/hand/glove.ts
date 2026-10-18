// The EVA glove drawn over the tracked hand: tapered fabric finger segments with knuckle pads, rubber grip pads and
// fingertip caps (the caps light up with the motors), a padded palm, and a gauntlet that ends in the anodized
// wrist-disconnect ring. The geometry is real (rebuilt from the 21 landmarks on each tracker frame, a few thousand
// vertices written into preallocated buffers), so shadows and the ambient-occlusion pass see the glove as it is drawn.
import * as THREE from "three";
import { bake, cached, cells, fbm, hash01 } from "../gfx/procedural";

// One texture tile spans 24 mm: 16 threads of 1.5 mm. A real weave is finer, but would alias to grey at arm's length.
const TILE_M = 0.024;

// finger radii (thumb..pinky) at the first joint of each chain, tapering toward the tip: a pressurized glove is
// about a third thicker than the hand inside it
const FINGER_R = [0.0148, 0.0124, 0.0127, 0.0119, 0.0106];
const TAPER = [1, 0.9, 0.82, 0.78];
const JOINTS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PALM_DORSAL_M = 0.015, PALM_PALMAR_M = 0.012; // palm thickness either side of the knuckle plane

const FABRIC_TINT = new THREE.Color(0xffffff), PAD_TINT = new THREE.Color(0xd8d6d0);
const ANODIZED = new THREE.Color(0x3f6fc4), SILVER = new THREE.Color(0xd6d8dc);
const MOTOR_HOT = new THREE.Color(0xffa133);
const MOTOR_GLOW = 5; // emissive intensity at full level: enough to bloom (the threshold sits at a luminance of 2.5)

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------- materials

function fabricMaps() {
  return cached("glove.fabric", () => bake(256, (u, v, o) => {
    // plain weave: warp threads run along v, weft along u, and at alternate crossings the warp lies on top;
    // every 8th thread is doubled (the ripstop grid)
    const n = 16, x = u * n, y = v * n, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const warpOver = ((ix + iy) & 1) === 0;
    const sx = Math.sin(Math.PI * fx), sy = Math.sin(Math.PI * fy);
    let warp = Math.sqrt(sx) * (warpOver ? 0.7 + 0.3 * sy : 0.7 - 0.3 * sy);
    let weft = Math.sqrt(sy) * (warpOver ? 0.7 - 0.3 * sx : 0.7 + 0.3 * sx);
    if (ix % 8 === 0) warp *= 1.12;
    if (iy % 8 === 0) weft *= 1.12;
    const h = Math.max(warp, weft) + 0.06 * fbm(u, v, 32, 5, 3);
    const thread = (warp > weft ? hash01(ix, 0, 3) : hash01(0, iy, 4)) - 0.5;
    const shade = (0.8 + 0.18 * h) * (1 + 0.03 * thread) * (0.97 + 0.03 * fbm(u, v, 4, 6, 3));
    o.r = 0.93 * shade; o.g = 0.925 * shade; o.b = 0.9 * shade;
    o.height = h;
    o.rough = 0.95 - 0.12 * h;
    o.ao = 0.6 + 0.4 * Math.min(1, h);
  }, { depth: 0.012 }));
}

function rubberMaps() {
  return cached("glove.rubber", () => bake(256, (u, v, o) => {
    const c = cells(u, v, 12, 9); // moulded grip dots
    const dot = THREE.MathUtils.smoothstep(0.42 - c.f1, 0, 0.12);
    const shade = (0.9 + 0.1 * dot) * (0.96 + 0.04 * fbm(u, v, 16, 2, 3));
    o.r = 0.52 * shade; o.g = 0.55 * shade; o.b = 0.58 * shade;
    o.height = dot + 0.04 * fbm(u, v, 64, 3, 2);
    o.rough = 0.72 - 0.16 * dot;
  }, { depth: 0.01 }));
}

function metalMaps() {
  return cached("glove.metal", () => bake(256, (u, v, o) => {
    // turned aluminium: fine circumferential lathe marks (rows of constant v) and a few smudges
    const line = hash01(0, Math.floor(v * 256), 21);
    const smudge = fbm(u, v, 4, 22, 3);
    o.r = o.g = o.b = 0.96 + 0.04 * line;
    o.height = 0.15 * line;
    o.rough = 0.26 + 0.1 * line + 0.08 * smudge;
    o.metal = 1;
  }, { depth: 0.004 }));
}

/** Six texels for the emissive map (linear): the five fingertip motors and one that stays dark (pads, palm). */
function motorTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(6 * 4), 6, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.channel = 1; // sampled with the uv1 attribute, which picks a texel per fingertip
  t.needsUpdate = true;
  return t;
}
const DARK_SLOT = 5;

// ---------------------------------------------------------------------------------------------- capsules

const RADIAL = 16, CAP_ROWS = 4;
const ROWS = 2 * (CAP_ROWS + 1), COLS = RADIAL + 1, CAPSULE_VERTS = ROWS * COLS;

// Unit template: rows from the south pole up to the equator belong to the start sphere, the rest to the end sphere,
// and the band between the two equator rows is the tapered side. The seam (u = 0) runs along the palm side.
const TEMPLATE = (() => {
  const dir = new Float32Array(CAPSULE_VERTS * 3), end = new Uint8Array(CAPSULE_VERTS);
  for (let r = 0; r < ROWS; r++) {
    const top = r > CAP_ROWS;
    const lat = ((top ? r - CAP_ROWS - 1 : r - CAP_ROWS) / CAP_ROWS) * (Math.PI / 2);
    for (let c = 0; c < COLS; c++) {
      const a = (c / RADIAL) * Math.PI * 2, i = r * COLS + c;
      dir[i * 3] = Math.sin(a) * Math.cos(lat);
      dir[i * 3 + 1] = Math.sin(lat);
      dir[i * 3 + 2] = -Math.cos(a) * Math.cos(lat);
      end[i] = top ? 1 : 0;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < RADIAL; c++) {
      const a = r * COLS + c, b = a + COLS;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { dir, end, index };
})();

/**
 * Many tapered capsules (two spheres joined by a cone) in one mesh. Each is set from its two end points and radii;
 * `up` turns it about its axis (texture seam opposite) and `flat` squashes it along `up` into a pad.
 */
export class CapsuleBatch {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private nrm: THREE.BufferAttribute;
  private uv: THREE.BufferAttribute;

  constructor(readonly count: number, material: THREE.Material, tint: (i: number) => THREE.Color,
              slot?: (i: number) => number) {
    const n = count * CAPSULE_VERTS;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nrm = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const color = new Float32Array(n * 3), uv1 = new Float32Array(n * 2);
    const index = new Uint16Array(count * TEMPLATE.index.length);
    for (let k = 0; k < count; k++) {
      const t = tint(k), s = ((slot?.(k) ?? DARK_SLOT) + 0.5) / 6;
      for (let v = k * CAPSULE_VERTS; v < (k + 1) * CAPSULE_VERTS; v++) {
        color.set([t.r, t.g, t.b], v * 3);
        uv1.set([s, 0.5], v * 2);
      }
      TEMPLATE.index.forEach((j, m) => (index[k * TEMPLATE.index.length + m] = j + k * CAPSULE_VERTS));
    }
    geo.setAttribute("position", this.pos);
    geo.setAttribute("normal", this.nrm);
    geo.setAttribute("uv", this.uv);
    geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  set(k: number, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, up: THREE.Vector3, flat = 1): void {
    const len = _y.subVectors(b, a).length();
    if (len > 1e-6) _y.divideScalar(len); else _y.set(0, 1, 0);
    _z.copy(up).addScaledVector(_y, -up.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(_y.y, _y.z, _y.x).cross(_y);
    _z.normalize();
    _x.crossVectors(_y, _z);
    // a whole number of tiles around, so the weave meets itself at the seam
    const around = Math.max(1, Math.round((Math.PI * (r0 + r1)) / TILE_M));
    const p = this.pos.array as Float32Array, nr = this.nrm.array as Float32Array, uv = this.uv.array as Float32Array;
    const { dir, end } = TEMPLATE;
    for (let i = 0, o = k * CAPSULE_VERTS; i < CAPSULE_VERTS; i++, o++) {
      const dx = dir[i * 3], dy = dir[i * 3 + 1], dz = dir[i * 3 + 2], e = end[i], r = e ? r1 : r0, along = e * len;
      const ox = dx * r, oy = dy * r, oz = dz * r * flat;
      p[o * 3] = a.x + _y.x * along + _x.x * ox + _y.x * oy + _z.x * oz;
      p[o * 3 + 1] = a.y + _y.y * along + _x.y * ox + _y.y * oy + _z.y * oz;
      p[o * 3 + 2] = a.z + _y.z * along + _x.z * ox + _y.z * oy + _z.z * oz;
      const nz = dz / flat, inv = 1 / Math.hypot(dx, dy, nz);
      nr[o * 3] = (_x.x * dx + _y.x * dy + _z.x * nz) * inv;
      nr[o * 3 + 1] = (_x.y * dx + _y.y * dy + _z.y * nz) * inv;
      nr[o * 3 + 2] = (_x.z * dx + _y.z * dy + _z.z * nz) * inv;
      uv[o * 2] = ((i % COLS) / RADIAL) * around;
      uv[o * 2 + 1] = (along + oy) / TILE_M;
    }
  }

  commit(): void {
    this.pos.needsUpdate = this.nrm.needsUpdate = this.uv.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------- palm

// The palm is a pillow: an outline around the wrist, thumb base and knuckles, and rings drawn in toward its centre
// that rise to the back of the hand (fabric) and to the palm (rubber).
const CTRL = 10, SPAN = 3, OUTLINE = CTRL * SPAN;
const RINGS = [0, 0.1, 0.28, 0.55, 0.8];
const LIFT = RINGS.map((t) => Math.sqrt(1 - (1 - Math.min(1, t / 0.6)) ** 2)); // round at the rim, flat on top
const SIDE_VERTS = RINGS.length * OUTLINE + 1;

const PALM_INDEX = (() => {
  const index: number[] = [];
  for (let side = 0; side < 2; side++) {
    const base = side * SIDE_VERTS, centre = base + SIDE_VERTS - 1;
    // outline counter-clockwise about the palm normal: palm-side faces keep that winding, back-of-hand ones flip it
    const tri = (a: number, b: number, c: number) => (side === 1 ? index.push(a, b, c) : index.push(a, c, b));
    for (let k = 0; k < RINGS.length; k++) {
      for (let i = 0; i < OUTLINE; i++) {
        const i1 = (i + 1) % OUTLINE, o = base + k * OUTLINE;
        if (k === RINGS.length - 1) tri(o + i, o + i1, centre);
        else {
          tri(o + i, o + i1, o + OUTLINE + i);
          tri(o + i1, o + OUTLINE + i1, o + OUTLINE + i);
        }
      }
    }
  }
  return index;
})();

class Palm {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private nrm: THREE.BufferAttribute;
  private uv: THREE.BufferAttribute;
  private ctrl = Array.from({ length: CTRL }, () => new THREE.Vector3());
  private outline = Array.from({ length: OUTLINE }, () => new THREE.Vector3());
  private centre = new THREE.Vector3();
  private q = new THREE.Vector3();
  private rel = new THREE.Vector3();

  constructor(fabric: THREE.Material, rubber: THREE.Material) {
    const n = 2 * SIDE_VERTS, geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nrm = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("normal", this.nrm);
    geo.setAttribute("uv", this.uv);
    geo.setAttribute("uv1", new THREE.BufferAttribute(new Float32Array(n * 2).fill((DARK_SLOT + 0.5) / 6), 2));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    geo.setIndex(PALM_INDEX);
    const half = PALM_INDEX.length / 2;
    geo.addGroup(0, half, 0);
    geo.addGroup(half, half, 1);
    this.mesh = new THREE.Mesh(geo, [fabric, rubber]);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  /** `lat` points from the index knuckle toward the pinky, `axis` from the wrist toward the knuckles, `n` palm-ward. */
  fit(p: THREE.Vector3[], lat: THREE.Vector3, axis: THREE.Vector3, n: THREE.Vector3, side: number): void {
    const c = this.centre.copy(p[0]).multiplyScalar(2).add(p[5]).add(p[9]).add(p[13]).add(p[17]).divideScalar(6);
    const k = this.ctrl;
    k[0].copy(p[0]).addScaledVector(lat, -0.031); // wrist, thumb side
    k[1].copy(p[1]).addScaledVector(lat, -0.01); // base of the thumb
    k[2].copy(p[2]).addScaledVector(lat, -0.004);
    k[3].lerpVectors(p[2], p[5], 0.5).lerp(c, 0.2); // the web between thumb and index
    k[4].copy(p[5]).addScaledVector(axis, 0.007).addScaledVector(lat, -0.006); // knuckles, a little past the joints
    k[5].copy(p[9]).addScaledVector(axis, 0.009);
    k[6].copy(p[13]).addScaledVector(axis, 0.008);
    k[7].copy(p[17]).addScaledVector(axis, 0.005).addScaledVector(lat, 0.006);
    k[8].lerpVectors(p[17], p[0], 0.5).addScaledVector(lat, 0.011); // pinky-side edge
    k[9].copy(p[0]).addScaledVector(lat, 0.031); // wrist, pinky side
    // closed uniform Catmull-Rom through the control points; a left hand runs the other way round its palm normal
    for (let s = 0; s < CTRL; s++) {
      const at = (j: number) => k[(((side > 0 ? s + j : -s - j) % CTRL) + CTRL) % CTRL];
      const p0 = at(-1), p1 = at(0), p2 = at(1), p3 = at(2);
      for (let j = 0; j < SPAN; j++) {
        const t = j / SPAN, t2 = t * t, t3 = t2 * t;
        const w0 = -0.5 * t3 + t2 - 0.5 * t, w1 = 1.5 * t3 - 2.5 * t2 + 1;
        const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t, w3 = 0.5 * t3 - 0.5 * t2;
        this.outline[s * SPAN + j].copy(p0).multiplyScalar(w0).addScaledVector(p1, w1).addScaledVector(p2, w2)
          .addScaledVector(p3, w3);
      }
    }
    const pos = this.pos.array as Float32Array, uv = this.uv.array as Float32Array;
    for (let s = 0; s < 2; s++) {
      const lift = s === 0 ? -PALM_DORSAL_M : PALM_PALMAR_M; // along n: negative is the back of the hand
      let v = s * SIDE_VERTS;
      const put = (q: THREE.Vector3) => {
        q.toArray(pos, v * 3);
        this.rel.subVectors(q, c);
        uv[v * 2] = this.rel.dot(lat) / TILE_M;
        uv[v * 2 + 1] = this.rel.dot(axis) / TILE_M;
        v++;
      };
      RINGS.forEach((t, r) => {
        for (const o of this.outline) put(this.q.lerpVectors(o, c, t).addScaledVector(n, lift * LIFT[r]));
      });
      put(this.q.copy(c).addScaledVector(n, lift * 1.05));
    }
    smoothNormals(pos, this.nrm.array as Float32Array, PALM_INDEX);
    this.pos.needsUpdate = this.nrm.needsUpdate = this.uv.needsUpdate = true;
  }
}

/** Area-weighted vertex normals, written in place (BufferGeometry.computeVertexNormals allocates). */
function smoothNormals(pos: Float32Array, out: Float32Array, index: number[]): void {
  out.fill(0);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    _a.fromArray(pos, a);
    _b.fromArray(pos, b).sub(_a);
    _c.fromArray(pos, c).sub(_a);
    _b.cross(_c);
    out[a] += _b.x; out[a + 1] += _b.y; out[a + 2] += _b.z;
    out[b] += _b.x; out[b + 1] += _b.y; out[b + 2] += _b.z;
    out[c] += _b.x; out[c + 1] += _b.y; out[c + 2] += _b.z;
  }
  for (let v = 0; v < out.length; v += 3) {
    const l = Math.hypot(out[v], out[v + 1], out[v + 2]) || 1;
    out[v] /= l; out[v + 1] /= l; out[v + 2] /= l;
  }
}

// ---------------------------------------------------------------------------------------------- cuff

// Profiles from the wrist toward the elbow: [y (m), radius across the wrist, radius through it, colour, material,
// opacity]. The gauntlet starts flattened like the wrist inside it and rounds out into the rigid ring, which has two
// bearing lips around an anodized band. The arm isn't tracked, so the suit sleeve beyond fades out (like VR hands):
// a solid stub would show its open end whenever the forearm points at the eye, and a whole arm would hide the work.
type Ring = [number, number, number, THREE.Color, 0 | 1, number];
const round = (y: number, r: number, c: THREE.Color, m: 0 | 1, alpha = 1): Ring => [y, r, r, c, m, alpha];
const CUFF: Ring[] = [
  [-0.014, 0.03, 0.018, FABRIC_TINT, 0, 1], [0, 0.032, 0.021, FABRIC_TINT, 0, 1],
  [0.025, 0.035, 0.027, FABRIC_TINT, 0, 1], [0.05, 0.04, 0.035, FABRIC_TINT, 0, 1],
  [0.066, 0.0435, 0.042, FABRIC_TINT, 0, 1], round(0.074, 0.0445, FABRIC_TINT, 0),
  round(0.072, 0.0435, SILVER, 1), round(0.0738, 0.049, SILVER, 1), round(0.0785, 0.0498, SILVER, 1),
  round(0.0792, 0.0503, ANODIZED, 1), round(0.0905, 0.0503, ANODIZED, 1), round(0.0912, 0.0484, SILVER, 1),
  round(0.0935, 0.0484, SILVER, 1), round(0.0942, 0.0508, SILVER, 1), round(0.0992, 0.0508, SILVER, 1),
  round(0.1008, 0.047, SILVER, 1),
];
// the sleeve starts tucked inside the ring's last lip (r 0.047 at 0.1008) and flares out from under it: a surface
// that grazes the lip would z-fight with it
const SLEEVE: Ring[] = [
  round(0.096, 0.0445, FABRIC_TINT, 0), round(0.106, 0.0478, FABRIC_TINT, 0), round(0.125, 0.0503, FABRIC_TINT, 0),
  round(0.145, 0.051, FABRIC_TINT, 0, 0.7), round(0.165, 0.0515, FABRIC_TINT, 0, 0.25),
  round(0.185, 0.052, FABRIC_TINT, 0, 0),
];
const LOFT_RADIAL = 32;

/** A tube through the profile's rings (static: the whole cuff moves as one), one geometry group per material. */
function loft(rings: Ring[]): THREE.BufferGeometry {
  const pos: number[] = [], color: number[] = [], uv: number[] = [], index: number[] = [];
  const fades = rings.some((r) => r[5] < 1); // RGBA only where needed: it compiles a separate shader variant
  const groups: [number, number, number][] = [];
  rings.forEach(([y, rx, rz, tint, mat, alpha], r) => {
    const around = Math.max(1, Math.round((Math.PI * (rx + rz)) / TILE_M));
    for (let c = 0; c <= LOFT_RADIAL; c++) {
      const a = (c / LOFT_RADIAL) * Math.PI * 2;
      pos.push(Math.sin(a) * rx, y, -Math.cos(a) * rz);
      color.push(tint.r, tint.g, tint.b);
      if (fades) color.push(alpha);
      uv.push((c / LOFT_RADIAL) * around, y / TILE_M);
    }
    if (r === 0 || rings[r - 1][4] !== mat) return; // a new part starts here: no band from the previous ring
    const start = index.length;
    for (let c = 0; c < LOFT_RADIAL; c++) {
      const a = (r - 1) * (LOFT_RADIAL + 1) + c, b = a + LOFT_RADIAL + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const last = groups[groups.length - 1];
    if (last && last[2] === mat && last[0] + last[1] === start) last[1] += index.length - start;
    else groups.push([start, index.length - start, mat]);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(color, fades ? 4 : 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  groups.forEach(([start, count, mat]) => geo.addGroup(start, count, mat));
  geo.computeVertexNormals();
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
  for (let r = 0; r < rings.length; r++) { // the seam's two copies of each vertex each saw only one side
    const a = r * (LOFT_RADIAL + 1), b = a + LOFT_RADIAL;
    _a.fromBufferAttribute(nrm, a).add(_b.fromBufferAttribute(nrm, b)).normalize();
    nrm.setXYZ(a, _a.x, _a.y, _a.z);
    nrm.setXYZ(b, _a.x, _a.y, _a.z);
  }
  return geo;
}

// ---------------------------------------------------------------------------------------------- glove

export class Glove {
  readonly group = new THREE.Group();
  private fabric: CapsuleBatch;
  private rubber: CapsuleBatch;
  private palm: Palm;
  private forearm = new THREE.Group(); // gauntlet, ring and sleeve, posed as one at the wrist
  private motors = motorTexture();
  private basis = new THREE.Matrix4();
  // the hand's frame this frame: palm normal, back-of-hand normal, toward the pinky, toward the knuckles; the tip
  private n = new THREE.Vector3();
  private back = new THREE.Vector3();
  private lat = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private tip = new THREE.Vector3();

  constructor() {
    const fm = fabricMaps(), rm = rubberMaps(), mm = metalMaps();
    const fabric = new THREE.MeshStandardMaterial({ map: fm.map, normalMap: fm.normalMap, roughnessMap: fm.ormMap,
      aoMap: fm.ormMap, aoMapIntensity: 0.6, vertexColors: true });
    const rubber = new THREE.MeshStandardMaterial({ map: rm.map, normalMap: rm.normalMap, roughnessMap: rm.ormMap,
      emissive: 0xffffff, emissiveMap: this.motors, emissiveIntensity: MOTOR_GLOW });
    const metal = new THREE.MeshStandardMaterial({ normalMap: mm.normalMap, roughnessMap: mm.ormMap,
      metalnessMap: mm.ormMap, metalness: 1, vertexColors: true });

    // fabric: 15 finger segments, then 4 knuckle pads on the backs of the proximal phalanges, then the knuckle bar
    this.fabric = new CapsuleBatch(20, fabric, (i) => (i < 15 ? FABRIC_TINT : PAD_TINT));
    // rubber: 5 fingertip caps (each lit by its motor), then grip pads on the proximal and middle phalanges
    this.rubber = new CapsuleBatch(13, rubber, () => FABRIC_TINT, (i) => (i < 5 ? i : DARK_SLOT));
    this.palm = new Palm(fabric, rubber);
    this.fabric.mesh.name = "glove.fabric";
    this.rubber.mesh.name = "glove.rubber";
    this.palm.mesh.name = "glove.palm";
    // Whatever is drawn before the fading sleeve shows through it, the far side of the hollow ring included (as thin
    // bright arcs, when the forearm points at the eye). So the cuff is drawn in the transparent pass as well, after
    // the sleeve, whose depth then hides the parts behind it.
    const [fading, fadingMetal] = [fabric.clone(), metal.clone()];
    fading.transparent = fadingMetal.transparent = true;
    const cuff = new THREE.Mesh(loft(CUFF), [fading, fadingMetal]), sleeve = new THREE.Mesh(loft(SLEEVE), fading);
    cuff.renderOrder = 1;
    cuff.name = "glove.cuff";
    sleeve.name = "glove.sleeve";
    for (const m of [cuff, sleeve]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
    }
    this.forearm.add(cuff, sleeve);
    this.group.add(this.fabric.mesh, this.rubber.mesh, this.palm.mesh, this.forearm);
  }

  /**
   * Fit the glove to 21 landmarks in metres (camera space). `side` is +1 for a right hand, -1 for a left: it says
   * which face of the knuckle plane is the palm.
   */
  fit(p: THREE.Vector3[], side: number): void {
    const { n, back, lat, axis } = this;
    n.crossVectors(_a.subVectors(p[5], p[0]), _b.subVectors(p[17], p[0])).normalize().multiplyScalar(side);
    back.copy(n).negate();
    lat.subVectors(p[17], p[5]).normalize();
    axis.subVectors(p[9], p[0]);
    axis.addScaledVector(n, -axis.dot(n)).normalize();

    let f = 0, pad = 5;
    JOINTS.forEach((j, finger) => {
      for (let s = 0; s < 3; s++) {
        const a = p[j[s]], r0 = FINGER_R[finger] * TAPER[s], r1 = FINGER_R[finger] * TAPER[s + 1];
        const b = this.tip.copy(p[j[s + 1]]);
        if (s === 2) b.addScaledVector(_a.subVectors(b, a).normalize(), -0.5 * r1); // the cap ends at the fingertip
        this.fabric.set(f++, a, b, r0, r1, back);
        if (s === 2) this.rubber.set(finger, _a.lerpVectors(a, b, 0.42), b, r1 * 1.08, r1 * 1.08, back);
        else if (finger > 0) {
          // grip pads sit on the palm side of the phalanx
          const lift = r0 * 0.62;
          this.rubber.set(pad++, _a.lerpVectors(a, b, 0.22).addScaledVector(n, lift),
            _b.lerpVectors(a, b, 0.78).addScaledVector(n, lift), r0 * 0.6, r1 * 0.6, n, 0.42);
        }
      }
    });
    for (let finger = 1; finger < 5; finger++) {
      const a = p[JOINTS[finger][0]], b = p[JOINTS[finger][1]], r = FINGER_R[finger], lift = r * 0.72;
      this.fabric.set(f++, _a.lerpVectors(a, b, 0.2).addScaledVector(back, lift),
        _b.lerpVectors(a, b, 0.62).addScaledVector(back, lift), r * 0.62, r * 0.55, back, 0.5);
    }
    // the padded bar across the back of the knuckles
    const lift = PALM_DORSAL_M * 0.8;
    this.fabric.set(f, _a.copy(p[5]).addScaledVector(back, lift).addScaledVector(axis, -0.006),
      _b.copy(p[17]).addScaledVector(back, lift).addScaledVector(axis, -0.006), 0.0085, 0.008, back, 0.55);
    this.fabric.commit();
    this.rubber.commit();

    this.palm.fit(p, lat, axis, n, side);

    // the forearm isn't tracked: assume a straight wrist, drooping a little toward the body
    _y.copy(axis).negate().add(_a.set(0, -0.3, 0.15)).normalize();
    _z.copy(n).addScaledVector(_y, -n.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    this.forearm.quaternion.setFromRotationMatrix(this.basis.makeBasis(_x, _y, _z));
    this.forearm.position.copy(p[0]);
  }

  /** Light the fingertip caps with the live motor levels (thumb..pinky, 0..1). */
  showMotors(levels: number[]): void {
    const data = this.motors.image.data as Uint8Array;
    for (let i = 0; i < 5; i++) {
      const k = 255 * Math.min(1, (levels[i] ?? 0) * 1.4);
      data[i * 4] = Math.round(k * MOTOR_HOT.r);
      data[i * 4 + 1] = Math.round(k * MOTOR_HOT.g);
      data[i * 4 + 2] = Math.round(k * MOTOR_HOT.b);
    }
    this.motors.needsUpdate = true;
  }
}
