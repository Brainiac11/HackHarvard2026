// Apollo-LRV-style rover mesh (PLAN.md §9.4): tubular aluminium chassis, woven-wire wheels with titanium chevrons on
// double-wishbone suspension, two webbed seats with belts, T-handle hand controller, live control & display console,
// umbrella high-gain and helical low-gain antennas, TV camera, MLI-wrapped batteries and electronics under mirror
// radiators, and an aft payload pallet with a tool carrier and sample bags.
// Static parts are merged per material (one draw call each); wheels, suspension links and the T-handle move.
// Local frame: x right, y up, forward = -z; y = 0 is about axle height.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LUNAR_G, ROVER, RoverModel, type HeightFn } from "./rover";
import { RoverConsole } from "./roverConsole";
import { roverMaterials, TILE, type RoverMaterialName, type RoverMaterials } from "./roverMaterials";

type V3 = readonly [number, number, number];

const R = ROVER.wheelRadius;
const BODY_LIFT = 0.05; // body origin above the model's spring top minus rest length: puts y = 0 near the axles
const REST_Y = (ROVER.mass * LUNAR_G) / 4 / ROVER.k - BODY_LIFT; // wheel centre height at static sag
const HALF_TRACK = ROVER.track / 2, HALF_BASE = ROVER.wheelbase / 2;
const TYRE_W = 0.23, HUB_R = 0.29;
const RAIL_X = 0.5, RAIL_Y = -0.05, DECK_Y = -0.035;
// suspension: arms hinge on the frame rail and meet the wheel's knuckle, above and below the axle
const HINGE_X = RAIL_X, KNUCKLE_X = HALF_TRACK - 0.17, ARM_LEN = KNUCKLE_X - HINGE_X;
const ARM_UP = 0.07, ARM_LO = -0.05;
const DAMPER_TOP: V3 = [0.45, REST_Y + 0.24, 0.09]; // x, y, z offset from the wheel
const SEAT_X = 0.31;
const CONSOLE_AT: V3 = [0, 0.53, -0.68], CONSOLE_TILT = -0.45;
const HANDLE_AT: V3 = [0, 0.395, -0.17];

/** The commander's (left seat) eye in rover space: the cockpit camera. */
export const COCKPIT_EYE = new THREE.Vector3(-SEAT_X, 0.98, 0.2);

const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);

// ------------------------------------------------------------------ geometry helpers (build time only)

/** Rotate a part (XYZ Euler) about its own centre, then move it to p. */
function at(g: THREE.BufferGeometry, p: V3, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  return g.applyMatrix4(new THREE.Matrix4().compose(v3(p), q, ONE));
}
const box = (w: number, h: number, d: number, p: V3, rx = 0, ry = 0, rz = 0) =>
  at(new THREE.BoxGeometry(w, h, d), p, rx, ry, rz);
const rbox = (w: number, h: number, d: number, r: number, p: V3, rx = 0, ry = 0, rz = 0) =>
  at(new RoundedBoxGeometry(w, h, d, 2, r), p, rx, ry, rz);

/** A straight tube from a to b. */
function rod(a: V3, b: V3, r: number, seg = 8): THREE.BufferGeometry {
  const va = v3(a), vb = v3(b), dir = vb.clone().sub(va);
  const g = new THREE.CylinderGeometry(r, r, dir.length(), seg);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  return g.applyMatrix4(new THREE.Matrix4().compose(va.lerp(vb, 0.5), q, ONE));
}

/** A tube through `points` with its corners bent to radius `bend`: seat frames, handholds, bumpers. */
function pipe(points: V3[], r: number, bend = 0.05, seg = 8): THREE.BufferGeometry {
  const p = points.map(v3), path = new THREE.CurvePath<THREE.Vector3>();
  let from = p[0];
  for (let i = 1; i < p.length - 1; i++) {
    const din = p[i].clone().sub(p[i - 1]), dout = p[i + 1].clone().sub(p[i]);
    const b = Math.min(bend, din.length() / 2, dout.length() / 2);
    const s = p[i].clone().addScaledVector(din.normalize(), -b), e = p[i].clone().addScaledVector(dout.normalize(), b);
    path.add(new THREE.LineCurve3(from, s));
    path.add(new THREE.QuadraticBezierCurve3(s, p[i], e));
    from = e;
  }
  path.add(new THREE.LineCurve3(from, p[p.length - 1]));
  return new THREE.TubeGeometry(path, Math.max(8, Math.ceil(path.getLength() / 0.02)), r, seg, false);
}

/** A flat strap (belt, webbing) from a to b, lying on a roughly horizontal surface. */
function strap(a: V3, b: V3, width: number, thick = 0.005): THREE.BufferGeometry {
  const va = v3(a), vb = v3(b), x = vb.clone().sub(va);
  const len = x.length();
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, UP).normalize(), y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.BoxGeometry(len, thick, width).applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z)
    .setPosition(va.lerp(vb, 0.5)));
}

/** Surface of revolution about the x axis (wheels, hubs); profile points are [radius, x]. */
const latheX = (profile: [number, number][], segments: number) =>
  new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments).rotateZ(-Math.PI / 2);

const _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();

/** Box-projected UVs, `tile` metres per texture repeat; the axis is chosen per triangle, so faces never smear. */
function boxUV(g: THREE.BufferGeometry, tile: number): void {
  const pos = g.getAttribute("position"), uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) _p[k].fromBufferAttribute(pos, i + k);
    _n.crossVectors(_e1.subVectors(_p[1], _p[0]), _e2.subVectors(_p[2], _p[0]));
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    for (let k = 0; k < 3; k++) {
      const q = _p[k];
      const [s, t] = ay >= ax && ay >= az ? [q.x, q.z] : ax >= az ? [q.z, q.y] : [q.x, q.y];
      uv[(i + k) * 2] = s / tile;
      uv[(i + k) * 2 + 1] = t / tile;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

/** Collects parts per material in one frame and merges them: one draw call per material. */
class Kit {
  private parts = new Map<RoverMaterialName, THREE.BufferGeometry[]>();

  /** `geo` is consumed. tint: sRGB hex multiplied into the texture. uv: keep the geometry's own UVs, scaled
   *  (patterns that follow the part: wire mesh), instead of box-projecting at the material's tile size. */
  add(mat: RoverMaterialName, geo: THREE.BufferGeometry, tint = 0xffffff, uv?: [number, number]): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    if (uv) {
      const a = g.getAttribute("uv");
      for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * uv[0], a.getY(i) * uv[1]);
    } else {
      boxUV(g, TILE[mat]);
    }
    const c = new THREE.Color(tint), n = g.getAttribute("position").count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.clearGroups();
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }

  /** Merge into one mesh per material under `parent`. */
  into<T extends THREE.Object3D>(parent: T, mats: RoverMaterials): T {
    for (const [name, list] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mats[name]);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
    }
    return parent;
  }
}

// ------------------------------------------------------------------ body

function chassis(k: Kit): void {
  for (const s of [-1, 1]) {
    k.add("aluminium", rod([s * RAIL_X, RAIL_Y, -1.52], [s * RAIL_X, RAIL_Y, 1.52], 0.022));
    // outboard handhold beside the seats
    k.add("aluminium", pipe([[s * RAIL_X, RAIL_Y, -0.62], [s * 0.57, 0.3, -0.5], [s * 0.57, 0.3, 0.12],
      [s * RAIL_X, RAIL_Y, 0.26]], 0.014, 0.08));
  }
  for (const z of [-1.52, -HALF_BASE, -0.72, 0.62, HALF_BASE, 1.52]) {
    k.add("aluminium", rod([-RAIL_X, RAIL_Y, z], [RAIL_X, RAIL_Y, z], 0.018));
  }
  for (const s of [-1, 1]) {
    k.add("aluminium", pipe([[-RAIL_X, RAIL_Y, s * 1.52], [-0.46, 0.0, s * 1.6], [0.46, 0.0, s * 1.6],
      [RAIL_X, RAIL_Y, s * 1.52]], 0.016, 0.05)); // bumpers
  }
  // centre floor (beaded panels), forward and aft decks
  k.add("floor", box(0.956, 0.012, 1.34, [0, DECK_Y - 0.006, -0.05]));
  k.add("paint", box(0.956, 0.012, 0.8, [0, DECK_Y - 0.006, -1.12]), 0xb9b7b0);
  k.add("paint", box(0.956, 0.012, 0.9, [0, DECK_Y - 0.006, 1.07]), 0xb9b7b0);

  for (const [f, r] of RoverModel.OFFSETS) {
    const s = Math.sign(r), z = -f;
    // suspension hinge brackets and the damper tower
    for (const dz of [-0.15, 0.15]) k.add("aluminium", box(0.05, 0.16, 0.04, [s * RAIL_X, -0.02, z + dz]));
    const top: V3 = [s * DAMPER_TOP[0], DAMPER_TOP[1], z + DAMPER_TOP[2]];
    k.add("aluminium", rod([s * RAIL_X, RAIL_Y, z + 0.24], top, 0.012));
    k.add("aluminium", rod([s * RAIL_X, RAIL_Y, z - 0.04], top, 0.012));
    k.add("dark", rbox(0.05, 0.04, 0.05, 0.01, top));
    // fiberglass fender over the top of the wheel, on two struts
    const ri = 0.475, a0 = THREE.MathUtils.degToRad(14), a1 = THREE.MathUtils.degToRad(166);
    const shape = new THREE.Shape();
    shape.absarc(0, 0, ri + 0.012, a0, a1, false);
    shape.absarc(0, 0, ri, a1, a0, true);
    const fender = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 28 });
    k.add("paint", fender.rotateY(Math.PI / 2).translate(s * HALF_TRACK - 0.15, REST_Y, z), 0xd2c9b2);
    for (const a of [38, 142]) {
      const t = THREE.MathUtils.degToRad(a);
      k.add("aluminium", rod([s * RAIL_X, RAIL_Y, z - 0.3 * Math.cos(t)],
        [s * (HALF_TRACK - 0.14), REST_Y + ri * Math.sin(t), z - ri * Math.cos(t)], 0.01));
    }
  }
}

function seats(k: Kit): void {
  for (const s of [-1, 1]) {
    const x = s * SEAT_X, hw = 0.2;
    k.add("aluminium", pipe([[x - hw, 0.22, -0.16], [x - hw, 0.19, 0.27], [x - hw, 0.74, 0.4], [x + hw, 0.74, 0.4],
      [x + hw, 0.19, 0.27], [x + hw, 0.22, -0.16], [x - hw, 0.22, -0.16]], 0.013, 0.05));
    for (const dx of [-0.17, 0.17]) {
      k.add("aluminium", rod([x + dx, 0.215, -0.14], [x + dx, DECK_Y, -0.11], 0.011));
      k.add("aluminium", rod([x + dx, 0.19, 0.25], [x + dx, DECK_Y, 0.3], 0.011));
    }
    // nylon webbing stretched over the pan and the back
    k.add("fabric", box(0.38, 0.008, 0.42, [x, 0.207, 0.055], 0.068), 0x9fb1c4);
    k.add("fabric", box(0.38, 0.52, 0.008, [x, 0.466, 0.336], 0.232), 0x9fb1c4);
    // seat belt lying across the empty seat: outboard anchor, over the pan, buckle, tail hanging off the front
    const belt = 0xdcd3bd, a: V3 = [x + s * 0.19, 0.219, 0.21], b: V3 = [x - s * 0.1, 0.229, -0.13];
    k.add("fabric", strap(a, b, 0.045), belt);
    k.add("fabric", strap([b[0], 0.226, -0.15], [x - s * 0.085, 0.07, -0.19], 0.045), belt);
    k.add("fabric", strap([x - s * 0.19, 0.205, 0.25], [x - s * 0.15, 0.22, 0.08], 0.045), belt);
    k.add("aluminium", strap([b[0] + s * 0.02, b[1], b[2] - 0.03], [b[0] - s * 0.02, b[1], b[2] + 0.03], 0.055, 0.012));
    // sample bags stowed under the seat, toe hold on the floor
    k.add("fabric", rbox(0.3, 0.13, 0.28, 0.03, [x, 0.035, 0.06]), 0xe7e3d8);
    k.add("aluminium", pipe([[x - 0.14, DECK_Y, -0.56], [x - 0.14, 0.05, -0.6], [x + 0.14, 0.05, -0.6],
      [x + 0.14, DECK_Y, -0.56]], 0.011, 0.03));
  }
  // centre armrest; the hand controller stands at its front end
  k.add("aluminium", rod([0, DECK_Y, 0.3], [0, 0.33, 0.24], 0.016));
  k.add("aluminium", rod([0, DECK_Y, -0.08], [0, 0.33, -0.06], 0.016));
  k.add("aluminium", rod([0, DECK_Y, -0.2], [0, 0.33, -0.17], 0.018));
  k.add("dark", rbox(0.07, 0.035, 0.38, 0.012, [0, 0.345, 0.08]));
  k.add("paint", rbox(0.09, 0.06, 0.12, 0.01, [0, 0.36, -0.17]), 0x5a5d61);
  const bellows: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) bellows.push(new THREE.Vector2(0.026 + (i % 2) * 0.006, 0.39 + i * 0.006));
  k.add("dark", new THREE.LatheGeometry(bellows, 16).translate(HANDLE_AT[0], 0, HANDLE_AT[2]));
}

/** Where the console face sits (rover space): tilted back toward the crew. */
const consoleMatrix = () => new THREE.Matrix4().compose(v3(CONSOLE_AT),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(CONSOLE_TILT, 0, 0)), ONE);

function consoleHousing(k: Kit): void {
  const m = consoleMatrix();
  k.add("aluminium", rod([0, DECK_Y, -0.56], [0, 0.4, -0.64], 0.022));
  k.add("aluminium", box(0.12, 0.01, 0.12, [0, DECK_Y + 0.005, -0.56]));
  k.add("paint", rbox(0.48, 0.31, 0.07, 0.012, [0, 0, 0]).applyMatrix4(m), 0x4a4d52);
  for (const s of [-1, 1]) {
    k.add("aluminium", pipe([[s * 0.24, -0.1, 0], [s * 0.285, -0.09, 0.02], [s * 0.285, 0.11, 0.02], [s * 0.24, 0.12, 0]],
      0.009, 0.03).applyMatrix4(m));
  }
  // sun compass on top: a dial and its shadow-casting gnomon
  k.add("dark", new THREE.CylinderGeometry(0.045, 0.045, 0.01, 20).translate(0.12, 0.16, 0).applyMatrix4(m));
  k.add("paint", box(0.004, 0.045, 0.035, [0.12, 0.185, 0]).applyMatrix4(m), 0xe8e6df);
}

function forwardChassis(k: Kit): void {
  for (const s of [-1, 1]) {
    // silver-zinc battery under gold MLI, mirror radiator on top, its dust cover flipped up and forward
    const x = s * 0.22;
    k.add("foil", rbox(0.32, 0.2, 0.36, 0.012, [x, DECK_Y + 0.1, -1.02]));
    k.add("mirror", box(0.29, 0.008, 0.33, [x, DECK_Y + 0.204, -1.02]));
    const hinge: V3 = [x, DECK_Y + 0.21, -1.2];
    k.add("paint", new THREE.BoxGeometry(0.32, 0.01, 0.36).translate(0, 0.005, 0.18).rotateX(-1.9)
      .translate(...hinge), 0xe8e6df);
    k.add("aluminium", rod([x - 0.16, hinge[1], hinge[2]], [x + 0.16, hinge[1], hinge[2]], 0.007));
  }
  // drive control electronics, then the comms relay unit (LCRU) on a bracket above it
  k.add("foil", rbox(0.62, 0.15, 0.2, 0.012, [0, DECK_Y + 0.075, -1.38]));
  k.add("mirror", box(0.56, 0.008, 0.16, [0, DECK_Y + 0.152, -1.38]));
  for (const s of [-1, 1]) k.add("aluminium", rod([s * 0.15, DECK_Y + 0.15, -1.38], [s * 0.15, 0.22, -1.42], 0.012));
  k.add("paint", rbox(0.4, 0.17, 0.14, 0.012, [0, 0.3, -1.42]), 0xe9e7e1);
  k.add("mirror", box(0.36, 0.008, 0.11, [0, 0.389, -1.42]));
  k.add("dark", box(0.3, 0.1, 0.008, [0, 0.29, -1.494]));

  // TV camera on its mast, nose down a little, with a sun hood
  k.add("aluminium", rod([0, 0.385, -1.47], [0, 0.98, -1.47], 0.016));
  k.add("dark", rbox(0.07, 0.05, 0.07, 0.01, [0, 1.0, -1.47]));
  k.add("paint", rbox(0.12, 0.11, 0.26, 0.012, [0, 1.08, -1.5], -0.12), 0xe6e4de);
  k.add("dark", at(new THREE.CylinderGeometry(0.036, 0.042, 0.09, 16), [0, 1.06, -1.66], Math.PI / 2 - 0.12));
  k.add("paint", box(0.13, 0.005, 0.11, [0, 1.13, -1.66], -0.12), 0xe6e4de);
}

function antennas(k: Kit): void {
  // high-gain: umbrella dish (ribs + gold mesh) on a mast, front right, aimed up and ahead
  k.add("aluminium", rod([0.38, DECK_Y, -1.42], [0.38, 1.3, -1.42], 0.018));
  k.add("aluminium", rbox(0.06, 0.08, 0.06, 0.01, [0.38, 0.0, -1.42]));
  const f = 0.3, rim = 0.45, aim = new THREE.Vector3(0.25, 0.6, -0.75).normalize();
  const dish = new THREE.Matrix4().compose(new THREE.Vector3(0.38, 1.34, -1.42).addScaledVector(aim, 0.05),
    new THREE.Quaternion().setFromUnitVectors(UP, aim), ONE);
  const para = (r: number) => (r * r) / (4 * f);
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) profile.push(new THREE.Vector2(0.03 + (rim - 0.03) * (i / 10), para(0.03 + (rim - 0.03) * (i / 10))));
  k.add("dish", new THREE.LatheGeometry(profile, 36).applyMatrix4(dish), 0xffffff, [18, 3]);
  for (let i = 0; i < 12; i++) {
    const phi = (i / 12) * Math.PI * 2, pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 8; j++) {
      const r = 0.03 + (rim - 0.03) * (j / 8);
      pts.push(new THREE.Vector3(r * Math.cos(phi), para(r) - 0.006, r * Math.sin(phi)));
    }
    k.add("aluminium", new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.005, 5).applyMatrix4(dish));
  }
  k.add("aluminium", rod([0, -0.02, 0], [0, f, 0], 0.007).applyMatrix4(dish));
  k.add("dark", new THREE.CylinderGeometry(0.024, 0.03, 0.05, 12).translate(0, f, 0).applyMatrix4(dish));
  k.add("aluminium", new THREE.CylinderGeometry(0.045, 0.045, 0.05, 16).applyMatrix4(dish));
  k.add("aluminium", rod([0, -0.02, 0], [0, -0.24, 0.02], 0.009).applyMatrix4(dish)); // pointing handle
  k.add("dark", rod([-0.05, -0.24, 0.02], [0.05, -0.24, 0.02], 0.013).applyMatrix4(dish));
  k.add("aluminium", rod([0.2, 0.0, 0.2], [0.2, 0.13, 0.2], 0.012).applyMatrix4(dish)); // boresight scope

  // low-gain: a gold helix around a fibreglass rod, front left
  k.add("aluminium", rod([-0.38, DECK_Y, -1.42], [-0.38, 0.98, -1.42], 0.014));
  k.add("aluminium", new THREE.CylinderGeometry(0.05, 0.05, 0.01, 16).translate(-0.38, 0.985, -1.42));
  const turns = 12, helix: THREE.Vector3[] = [];
  for (let i = 0; i <= turns * 16; i++) {
    const t = i / (turns * 16), a = t * turns * Math.PI * 2;
    helix.push(new THREE.Vector3(-0.38 + 0.033 * Math.cos(a), 1.0 + 0.4 * t, -1.42 + 0.033 * Math.sin(a)));
  }
  k.add("foil", new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), turns * 32, 0.0035, 5));
  k.add("paint", rod([-0.38, 0.98, -1.42], [-0.38, 1.42, -1.42], 0.01), 0xd8d0b8);
  k.add("dark", new THREE.SphereGeometry(0.014, 10, 8).translate(-0.38, 1.425, -1.42));
}

function aftPallet(k: Kit): void {
  // hand tool carrier: a frame at the very back, tools clipped upright, hammer across the lower bar
  const z = 1.4;
  k.add("aluminium", pipe([[-0.32, DECK_Y, z], [-0.32, 0.66, z], [0.32, 0.66, z], [0.32, DECK_Y, z]], 0.015, 0.05));
  for (const y of [0.22, 0.45]) k.add("aluminium", rod([-0.32, y, z], [0.32, y, z], 0.012));
  for (const s of [-1, 1]) k.add("aluminium", rod([s * 0.32, 0.4, z], [s * 0.32, DECK_Y, 1.1], 0.01));
  const tz = z + 0.045;
  const tool = (x: number, top: number) => {
    k.add("aluminium", rod([x, 0.02, tz], [x, top, tz], 0.011));
    for (const y of [0.22, 0.45]) k.add("dark", box(0.035, 0.03, 0.05, [x, y, z + 0.022]));
  };
  tool(-0.24, 0.8);
  k.add("dark", rod([-0.24, 0.8, tz], [-0.24, 0.9, tz], 0.016)); // extension handle grip
  k.add("dark", rod([-0.28, 0.905, tz], [-0.2, 0.905, tz], 0.012));
  tool(-0.1, 0.74); // scoop
  k.add("titanium", rbox(0.09, 0.12, 0.05, 0.012, [-0.1, 0.8, tz + 0.012], 0.25));
  tool(0.06, 0.74); // rake
  k.add("titanium", box(0.18, 0.02, 0.02, [0.06, 0.75, tz]));
  for (let i = 0; i < 9; i++) k.add("titanium", rod([-0.02 + i * 0.02, 0.75, tz], [-0.02 + i * 0.02, 0.83, tz + 0.01], 0.003, 5));
  tool(0.22, 0.7); // tongs
  for (const s of [-1, 1]) k.add("titanium", pipe([[0.22, 0.7, tz], [0.22 + s * 0.025, 0.76, tz], [0.22 + s * 0.012, 0.82, tz]], 0.005, 0.02, 5));
  k.add("dark", rod([-0.28, 0.25, z - 0.04], [0.05, 0.25, z - 0.04], 0.012)); // hammer
  k.add("titanium", box(0.04, 0.09, 0.035, [-0.28, 0.25, z - 0.04]));

  // sample collection bags with lids and straps, in holders
  for (const s of [-1, 1]) {
    const x = s * 0.2, y = DECK_Y + 0.11;
    k.add("fabric", rbox(0.26, 0.22, 0.18, 0.035, [x, y, 1.12]), 0xf0eee8);
    k.add("fabric", box(0.27, 0.012, 0.19, [x, y + 0.115, 1.115], 0.05), 0xd9d4c6);
    for (const dx of [-0.07, 0.07]) {
      k.add("fabric", box(0.03, 0.235, 0.004, [x + dx, y, 1.12 - 0.092]), 0xcfc4a8);
      k.add("fabric", box(0.03, 0.004, 0.19, [x + dx, y + 0.123, 1.115]), 0xcfc4a8);
    }
    k.add("aluminium", pipe([[x - 0.14, DECK_Y, 1.02], [x - 0.14, y, 1.02], [x + 0.14, y, 1.02], [x + 0.14, DECK_Y, 1.02]],
      0.008, 0.02));
  }
  // core tubes in their caddy
  for (let i = 0; i < 4; i++) {
    const tz2 = 0.74 + i * 0.05;
    k.add("aluminium", rod([-0.18, DECK_Y + 0.03, tz2], [0.18, DECK_Y + 0.03, tz2], 0.02, 12));
    for (const s of [-1, 1]) k.add("dark", rod([s * 0.18, DECK_Y + 0.03, tz2], [s * 0.2, DECK_Y + 0.03, tz2], 0.022, 12));
  }
  k.add("paint", box(0.44, 0.04, 0.24, [0, DECK_Y + 0.005, 0.815]), 0x8f8d88);
}

// ------------------------------------------------------------------ wheels and suspension

/** The rolling part of a wheel, built for a right-hand wheel (outboard = +x). */
function wheelSpin(k: Kit): void {
  const tyre: [number, number][] = [];
  for (let i = 0; i <= 18; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 18;
    tyre.push([HUB_R + (R - HUB_R) * Math.max(0, Math.cos(t)) ** 0.35, (TYRE_W / 2) * Math.sin(t)]);
  }
  k.add("wire", latheX(tyre, 64), 0xffffff, [22, 4]);
  // titanium chevrons riveted on the tread: V strips, half the contact area
  for (let i = 0; i < 40; i++) {
    for (const s of [-1, 1]) {
      const len = 0.125, th = 0.006;
      k.add("titanium", new THREE.BoxGeometry(len, th, 0.024).translate(s * len / 2, 0, 0).rotateY(s * 0.45)
        .translate(0, R + th / 2 - 0.002, 0).rotateX((i / 40) * Math.PI * 2));
    }
  }
  // inner bump-stop frame, seen through the mesh
  for (const x of [-0.07, 0.07]) {
    k.add("titanium", new THREE.TorusGeometry(0.335, 0.006, 5, 48).rotateY(Math.PI / 2).translate(x, 0, 0));
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, y = 0.335 * Math.cos(a), z = 0.335 * Math.sin(a);
    k.add("titanium", rod([-0.07, y, z], [0.07, y, z], 0.005, 5));
  }
  // spun-aluminium hub: dished disc with stiffening ribs and a bolted cap; a ring and spokes on the inboard rim
  // (lathe faces point to the right of the profile's direction: run it rim -> centre so the disc faces outboard)
  k.add("aluminium", latheX([[0.295, 0.1], [0.3, 0.112], [0.292, 0.118], [0.27, 0.108], [0.22, 0.104], [0.1, 0.112],
    [0.075, 0.125], [0.06, 0.142], [0.05, 0.15], [0.001, 0.15]], 40));
  for (let i = 0; i < 6; i++) {
    k.add("aluminium", new THREE.BoxGeometry(0.014, 0.15, 0.01).translate(0.112, 0.18, 0).rotateX((i / 6) * Math.PI * 2));
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.add("dark", new THREE.CylinderGeometry(0.008, 0.008, 0.014, 6).rotateZ(Math.PI / 2)
      .translate(0.144, 0.088 * Math.cos(a), 0.088 * Math.sin(a)));
  }
  k.add("aluminium", new THREE.TorusGeometry(0.292, 0.01, 6, 48).rotateY(Math.PI / 2).translate(-TYRE_W / 2, 0, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3, c = Math.cos(a), s = Math.sin(a);
    k.add("aluminium", rod([-TYRE_W / 2, 0.29 * c, 0.29 * s], [-0.035, 0.09 * c, 0.09 * s], 0.008, 6));
  }
}

/** The steered, non-rolling part: traction drive housing with cooling fins and the knuckle post. */
function wheelDrive(k: Kit): void {
  const grey = 0x8e8c86;
  k.add("paint", new THREE.CylinderGeometry(0.085, 0.085, 0.135, 20).rotateZ(Math.PI / 2).translate(-0.1025, 0, 0), grey);
  for (const x of [-0.06, -0.09, -0.12, -0.15]) {
    k.add("paint", new THREE.CylinderGeometry(0.097, 0.097, 0.006, 20).rotateZ(Math.PI / 2).translate(x, 0, 0), grey);
  }
  k.add("paint", rod([-(TYRE_W / 2 + 0.06), -0.085, 0], [-(TYRE_W / 2 + 0.06), 0.085, 0], 0.02), grey);
}

/** A wishbone in hinge space (hinge at the origin, reaching +x to the knuckle). */
function arm(k: Kit): void {
  k.add("aluminium", rod([0, 0, -0.14], [ARM_LEN, 0, -0.012], 0.013));
  k.add("aluminium", rod([0, 0, 0.14], [ARM_LEN, 0, 0.012], 0.013));
  k.add("aluminium", rod([0, 0, -0.16], [0, 0, 0.16], 0.022)); // torsion bar housing
  k.add("aluminium", rod([ARM_LEN, 0, -0.025], [ARM_LEN, 0, 0.025], 0.016));
}

/** Damper of unit length along +y (scaled to its stroke each frame). */
function damper(k: Kit): void {
  k.add("dark", new THREE.CylinderGeometry(0.024, 0.024, 0.5, 12).translate(0, 0.25, 0));
  k.add("dark", new THREE.CylinderGeometry(0.009, 0.009, 0.55, 8).translate(0, 0.72, 0));
}

const _end = new THREE.Vector3(), _dir = new THREE.Vector3();

/** One wheel station. It rides the suspension (y); `steer` turns the front pair and `spin` rolls the wheel. The
 *  suspension links hinge on the body, so they live there and follow the station in suspend(). */
export class RoverWheel extends THREE.Group {
  readonly steer = new THREE.Group();
  readonly spin = new THREE.Group();

  constructor(readonly side: 1 | -1, readonly front: boolean, private arms: THREE.Object3D[],
              private damper: THREE.Object3D) {
    super();
    this.add(this.steer);
    this.steer.add(this.spin);
  }

  /** Swing the wishbones and stretch the damper to the station's current height. */
  suspend(): void {
    const swing = this.side * Math.atan2(this.position.y - REST_Y, ARM_LEN);
    for (const a of this.arms) a.rotation.z = swing;
    _end.set(this.side * (KNUCKLE_X - 0.05), this.position.y + ARM_LO, this.position.z + 0.02);
    _dir.subVectors(_end, this.damper.position);
    const len = _dir.length();
    this.damper.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
    this.damper.scale.y = len;
  }
}

/** The rover body: the merged static mesh plus the parts poseRover animates. */
export class RoverBody extends THREE.Group {
  constructor(readonly handle: THREE.Object3D, readonly display: RoverConsole) {
    super();
  }
}

/** Build the rover: about 45 draw calls and 60k triangles. Metals reflect the scene's environment map. */
export function buildRoverMesh(): { group: RoverBody; wheels: RoverWheel[] } {
  const mats = roverMaterials();

  const handle = new THREE.Group();
  handle.position.set(...HANDLE_AT);
  const grip = new Kit();
  grip.add("aluminium", rod([0, 0, 0], [0, 0.12, 0], 0.011));
  grip.add("dark", rod([-0.075, 0.13, 0], [0.075, 0.13, 0], 0.016, 12));
  grip.add("dark", rbox(0.02, 0.02, 0.02, 0.006, [0.03, 0.15, 0]));
  grip.into(handle, mats);

  const display = new RoverConsole();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.285), new THREE.MeshStandardMaterial({
    map: display.texture, emissiveMap: display.texture, emissive: 0xffffff, emissiveIntensity: 0.35,
    roughness: 0.3, metalness: 0,
  }));
  screen.applyMatrix4(consoleMatrix().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.0356)));
  screen.receiveShadow = true;

  const body = new RoverBody(handle, display);
  const kit = new Kit();
  chassis(kit);
  seats(kit);
  consoleHousing(kit);
  forwardChassis(kit);
  antennas(kit);
  aftPallet(kit);
  kit.into(body, mats);
  body.add(handle, screen);

  const kitGroup = (build: (k: Kit) => void) => {
    const k = new Kit();
    build(k);
    return k.into(new THREE.Group(), mats);
  };
  const spinT = kitGroup(wheelSpin), driveT = kitGroup(wheelDrive), armT = kitGroup(arm), damperT = kitGroup(damper);
  const wheels = RoverModel.OFFSETS.map(([f, r]) => {
    const side = r > 0 ? 1 : -1, z = -f;
    const arms = [ARM_UP, ARM_LO].map((dy) => {
      const a = armT.clone();
      a.position.set(side * HINGE_X, REST_Y + dy, z);
      a.scale.x = side; // mirrored on the left: the arm reaches -x
      return a;
    });
    const d = damperT.clone();
    d.position.set(side * DAMPER_TOP[0], DAMPER_TOP[1], z + DAMPER_TOP[2]);
    body.add(...arms, d);
    const w = new RoverWheel(side, f > 0, arms, d);
    w.position.set(r, REST_Y, z);
    const spin = spinT.clone(), drive = driveT.clone();
    if (side < 0) spin.rotation.z = drive.rotation.z = Math.PI; // outboard is -x on the left
    w.spin.add(spin);
    w.steer.add(drive);
    body.add(w);
    w.suspend();
    return w;
  });
  return { group: body, wheels };
}

/** Pose the rover mesh from the model: chassis, wheel heights / spin / steering, suspension, T-handle, console. */
export function poseRover(body: RoverBody, wheels: RoverWheel[], m: RoverModel, height: HeightFn, dt: number): void {
  body.position.set(m.x, m.y - ROVER.restLength + BODY_LIFT, m.z);
  body.rotation.set(0, 0, 0);
  body.rotateY(-m.heading);
  body.rotateX(m.pitch);
  body.rotateZ(-m.roll);
  const steer = -THREE.MathUtils.degToRad(ROVER.maxSteerDeg) * m.steer; // positive steer turns right (clockwise)
  wheels.forEach((w, i) => {
    const [wx, wz] = m.wheelPos(i);
    w.position.y = THREE.MathUtils.clamp(height(wx, wz) + R - body.position.y, -0.45, 0.1);
    w.spin.rotation.x -= (m.v / R) * dt;
    if (w.front) w.steer.rotation.y = steer;
    w.suspend();
  });
  // the T-handle leans with the drive command: forward for throttle, sideways for steering
  body.handle.rotation.set(-0.35 * m.throttle, 0, -0.3 * m.steer);
  body.display.update(dt, m);
}
