// Drill press model: a floor-standing lunar core-sampling press built from primitives, merged into one mesh per
// material per moving part so the whole machine stays a few dozen draw calls. Frame: origin on the ground under the
// spindle, +y up, +z toward the operator, metres. Working heights come from PRESS (drillPress.ts).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { canvasTexture, noise } from "../gfx/procedural";
import type { PressMaterials } from "./drillMaterials";
import { PRESS, type SampleSpec } from "./drillPress";

export const BIT_R = 0.019; // 38 mm core bit
const HOLE_R = BIT_R + 0.0015;
const COL_Z = -0.3; // column axis
const MOTOR_Z = -0.56;
const CARRIAGE_TOP = 0.953; // the vises and parallels stand on it
const FEED_HANDLE = new THREE.Vector3(0.15, 1.68, -0.03);
const HANDWHEEL_X = 0.31;

type Mat = THREE.MeshStandardMaterial;
type V3 = [number, number, number];
interface Place { p?: V3; r?: V3; s?: V3 }
/** How UVs (in metres) are laid on a part: planar per face, wrapped around y, or the geometry's own u/v spans. */
type Mapping = "box" | "cyl" | { u: number; v: number };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _pos = new THREE.Vector3(), _scl = new THREE.Vector3();
const v2 = (x: number, y: number) => new THREE.Vector2(x, y);

/** A whole number of texture tiles over `metres`, so a wrapped seam lines up. */
function wrap(metres: number, mat: Mat): number {
  const tile = 1 / (mat.map?.repeat.x ?? 1);
  return Math.max(1, Math.round(metres / tile)) * tile;
}

function setUV(g: THREE.BufferGeometry, mapping: Mapping, mat: Mat): void {
  const pos = g.getAttribute("position"), nor = g.getAttribute("normal"), src = g.getAttribute("uv");
  const uv = new Float32Array(pos.count * 2);
  let around = 0;
  if (mapping === "cyl") {
    for (let i = 0; i < pos.count; i++) around = Math.max(around, Math.hypot(pos.getX(i), pos.getZ(i)));
    around = wrap(2 * Math.PI * around, mat);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (mapping === "box" || (mapping === "cyl" && ay > 0.9)) {
      [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
    } else if (mapping === "cyl") {
      [u, v] = [src.getX(i) * around, y];
    } else {
      [u, v] = [src.getX(i) * wrap(mapping.u, mat), src.getY(i) * mapping.v];
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function matrix({ p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] }: Place): THREE.Matrix4 {
  return _m.compose(_pos.set(...p), _q.setFromEuler(_e.set(r[0], r[1], r[2], "YXZ")), _scl.set(...s));
}

/** Collects primitives per material, then merges each material's share into a single shadow-casting mesh. */
class Parts {
  private byMat = new Map<Mat, THREE.BufferGeometry[]>();

  add(mat: Mat, geo: THREE.BufferGeometry, at: Place = {}, mapping: Mapping = "box"): this {
    setUV(geo, mapping, mat);
    geo.applyMatrix4(matrix(at));
    const flat = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(flat.attributes)) if (!["position", "normal", "uv"].includes(name)) flat.deleteAttribute(name);
    if (!this.byMat.has(mat)) this.byMat.set(mat, []);
    this.byMat.get(mat)!.push(flat);
    return this;
  }

  build(into: THREE.Object3D): void {
    for (const [mat, geos] of this.byMat) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      mesh.castShadow = mesh.receiveShadow = true;
      into.add(mesh);
    }
    this.byMat.clear();
  }
}

// primitives (centred, y up)
const box = (w: number, h: number, d: number, r = 0.004, seg = 2) =>
  r > 0 ? new RoundedBoxGeometry(w, h, d, seg, r) : new THREE.BoxGeometry(w, h, d);
const cyl = (r: number, h: number, seg = 32, r2 = r) => new THREE.CylinderGeometry(r, r2, h, seg);
const hex = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 6);
const lathe = (pts: [number, number][], seg = 48) => new THREE.LatheGeometry(pts.map(([x, y]) => v2(x, y)), seg);
const ALONG_X: V3 = [0, 0, Math.PI / 2];
const ALONG_Z: V3 = [Math.PI / 2, 0, 0];

function tube(points: V3[], radius: number, segments = 64): [THREE.TubeGeometry, Mapping] {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return [new THREE.TubeGeometry(curve, segments, radius, 10), { u: curve.getLength(), v: 2 * Math.PI * radius }];
}

/** Side profile (z, y) of the head casting, extruded across x with rounded edges. */
function headCasting(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.1, 1.6);
  s.lineTo(0.1, 1.74);
  s.quadraticCurveTo(0.1, 1.805, 0.04, 1.805);
  s.lineTo(-0.37, 1.805);
  s.quadraticCurveTo(-0.42, 1.805, -0.42, 1.76);
  s.lineTo(-0.42, 1.66);
  s.quadraticCurveTo(-0.42, 1.6, -0.36, 1.6);
  s.lineTo(0.1, 1.6);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.24, bevelThickness: 0.016, bevelSize: 0.016, bevelSegments: 4, curveSegments: 16 });
  g.rotateY(-Math.PI / 2); // shape x -> machine z, extrusion -> -x
  g.translate(0.12, 0, 0);
  g.computeVertexNormals();
  return g;
}

/** Stadium-shaped belt and gear cover spanning spindle and motor pulleys. */
function beltCover(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const front = 0.125, back = 0.115, len = -MOTOR_Z;
  s.absarc(0, 0, front, Math.PI, 0, true); // shape y -> machine -z
  s.lineTo(back, len);
  s.absarc(0, len, back, 0, Math.PI, false);
  s.lineTo(-front, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelThickness: 0.014, bevelSize: 0.014, bevelSegments: 4, curveSegments: 32 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Core bit barrel: hollow tube with three helical flutes, open at the bottom (y = 0) and `len` long. */
function flutedBarrel(len: number): THREE.BufferGeometry {
  const AROUND = 72, ALONG = 40, inner = BIT_R * 0.72, turns = 1.6;
  const pos: number[] = [], idx: number[] = [];
  const ring = (y: number, r: (a: number) => number) => {
    for (let i = 0; i <= AROUND; i++) {
      const a = (i / AROUND) * Math.PI * 2, rr = r(a);
      pos.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
    }
  };
  const flute = (a: number, y: number) => {
    const c = 0.5 + 0.5 * Math.cos(3 * (a - (y / len) * turns * Math.PI * 2));
    return BIT_R * (1 - 0.2 * c ** 4);
  };
  for (let j = 0; j <= ALONG; j++) ring((j / ALONG) * len, (a) => flute(a, (j / ALONG) * len));
  ring(0, () => inner); // bottom annulus, then the bore inside it
  ring(0.03, () => inner);
  const row = AROUND + 1;
  const quad = (a: number, b: number) => {
    for (let i = 0; i < AROUND; i++) idx.push(a + i, b + i, a + i + 1, a + i + 1, b + i, b + i + 1);
  };
  for (let j = 0; j < ALONG; j++) quad((j + 1) * row, j * row);
  quad(0, (ALONG + 1) * row);
  quad((ALONG + 1) * row, (ALONG + 2) * row);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let k = 0; k < pos.length / 3; k++) { uv[k * 2] = (k % row) / AROUND; uv[k * 2 + 1] = pos[k * 3 + 1] / len; }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

// --------------------------------------------------------------------------------------------------- samples

export interface SampleView {
  group: THREE.Group; // origin at the sample's bottom centre, inside the carriage
  bore: THREE.Mesh; // cup of unit depth below the top face, scaled in y by the bore depth
  boreMat: Mat;
  rim: THREE.Mesh; // cuttings heaped around the hole
  dust: THREE.Color; // cuttings / particle colour
  height: number;
}

const BRICK = { w: 0.2, d: 0.16 };
const CORE_R = 0.085;
const sampleDepth = (kind: "soft" | "hard") => (kind === "soft" ? BRICK.d : 2 * CORE_R);

/** Brick: a box whose top face has the bore's mouth cut out. */
function brickGeometry(h: number): THREE.BufferGeometry {
  const { w, d } = BRICK;
  const sides = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const top = new THREE.Shape([v2(-w / 2, -d / 2), v2(w / 2, -d / 2), v2(w / 2, d / 2), v2(-w / 2, d / 2)]);
  top.holes.push(new THREE.Path().absarc(0, 0, HOLE_R, 0, Math.PI * 2, true));
  const cap = new THREE.ShapeGeometry(top, 24).toNonIndexed();
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, h / 2, 0);
  // drop the box's own top face (+y is the third face: vertices 12..17 once non-indexed)
  const keep = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, n: number) => {
    const arr = Array.from(a.array as Float32Array);
    return new THREE.Float32BufferAttribute([...arr.slice(0, 12 * n), ...arr.slice(18 * n)], n);
  };
  for (const name of ["position", "normal", "uv"]) sides.setAttribute(name, keep(sides.getAttribute(name), name === "uv" ? 2 : 3));
  const g = mergeGeometries([sides, cap])!;
  g.translate(0, h / 2, 0);
  return g;
}

/** Core: a lathed cylinder with chamfered edges and the bore's mouth open in its top face. */
function coreGeometry(h: number): THREE.BufferGeometry {
  const c = 0.004;
  return lathe([[0, 0], [CORE_R - c, 0], [CORE_R, c], [CORE_R, h - c], [CORE_R - c, h], [HOLE_R, h]], 72);
}

/** Cuttings heaped around the hole, irregular so it reads as a pile rather than a ring. */
function rimGeometry(): THREE.BufferGeometry {
  const g = lathe([[HOLE_R + 0.045, 0], [HOLE_R + 0.024, 0.005], [HOLE_R + 0.01, 0.008], [HOLE_R + 0.002, 0.005], [HOLE_R - 0.001, 0]], 48);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getX(i), p.getZ(i)) / (Math.PI * 2) + 0.5;
    const r = Math.hypot(p.getX(i), p.getZ(i)), k = 1 + 0.35 * noise(a, 0.3, 7, 5) * Math.min(1, (r - HOLE_R) / 0.01);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * (1 + 0.6 * noise(a, 0.7, 11, 9)), p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function stickerTexture(specs: SampleSpec[]): THREE.CanvasTexture {
  return canvasTexture(512, 256 * specs.length, (g) => {
    specs.forEach((s, i) => {
      const y = i * 256;
      g.fillStyle = "#f4f1e8";
      g.fillRect(0, y, 512, 256);
      g.fillStyle = s.kind === "soft" ? "#c98a1b" : "#3a5ba8";
      g.fillRect(0, y, 512, 46);
      g.fillStyle = "#fff";
      g.font = "bold 30px system-ui, sans-serif";
      g.fillText(`SAMPLE ${String.fromCharCode(65 + i)} · ${s.kind.toUpperCase()}`, 18, y + 34);
      g.fillStyle = "#15161a";
      g.font = "bold 58px system-ui, sans-serif";
      g.fillText(s.label, 18, y + 112);
      g.font = "30px system-ui, sans-serif";
      g.fillStyle = "#3a3b40";
      g.fillText(`simulated hardness ${s.hardness}  ·  ${Math.round(s.height * 100)} cm`, 18, y + 158);
      for (let k = 0; k < 46; k++) { // barcode
        const wBar = 2 + ((k * 7919 + i * 31) % 5);
        g.fillRect(18 + k * 10, y + 186, wBar, 48);
      }
    });
  });
}

function buildSample(spec: SampleSpec, index: number, count: number, m: PressMaterials, sticker: THREE.Texture): SampleView {
  const soft = spec.kind === "soft";
  const group = new THREE.Group();
  const body = soft ? brickGeometry(spec.height) : coreGeometry(spec.height);
  const mat = soft ? m.regolith : m.basalt;
  setUV(body, soft ? "box" : "cyl", mat);
  const mesh = new THREE.Mesh(body, mat);
  mesh.castShadow = mesh.receiveShadow = true;

  // the bore takes the sample's own surface, darkened as it deepens (sunlight can't reach far down a 4 cm hole)
  const boreGeo = lathe([[0, -1], [HOLE_R, -1], [HOLE_R, 0]], 32);
  setUV(boreGeo, "box", mat);
  const boreMat = mat.clone();
  boreMat.side = THREE.DoubleSide;
  const bore = new THREE.Mesh(boreGeo, boreMat);
  bore.position.y = spec.height;
  bore.scale.y = 1e-4;

  const rimMat = m.powder.clone();
  const dust = new THREE.Color(soft ? 0x9a8f80 : 0x77777a);
  rimMat.color.copy(dust);
  const rimGeo = rimGeometry();
  setUV(rimGeo, "box", rimMat);
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.position.y = spec.height;
  rim.visible = false;
  rim.receiveShadow = true;

  // a printed sample tag on the face toward the operator, above the vise jaw
  const half = 1 / count;
  const tagGeo = soft ? new THREE.PlaneGeometry(0.16, 0.08)
    : new THREE.CylinderGeometry(CORE_R + 0.0008, CORE_R + 0.0008, 0.08, 32, 1, true, -0.94, 1.88);
  const uv = tagGeo.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (index + 1 - uv.getY(i)) * half);
  const tag = new THREE.Mesh(tagGeo, new THREE.MeshStandardMaterial({ map: sticker, roughness: 0.6 }));
  tag.position.set(0, 0.105, soft ? BRICK.d / 2 + 0.0008 : 0);

  group.add(mesh, bore, rim, tag);
  return { group, bore, boreMat, rim, dust, height: spec.height };
}

/** Machine vise holding a sample of depth `d` (along z) on parallels, its screw toward the operator. */
function vise(parts: Parts, m: PressMaterials, x: number, d: number): void {
  const base = CARRIAGE_TOP, jawH = 0.07, jawY = PRESS.baseY - 0.01 + jawH / 2;
  parts.add(m.blue, box(0.22, 0.012, 0.32, 0.003), { p: [x, base + 0.006, 0.01] });
  for (const side of [-1, 1]) {
    const z = side * (d / 2 + 0.006 + 0.0175);
    parts.add(m.blue, box(0.22, jawH, 0.035, 0.006, 3), { p: [x, jawY, z] });
    parts.add(m.brushed, box(0.2, 0.05, 0.006, 0.001), { p: [x, jawY + 0.005, side * (d / 2 + 0.003)] });
    parts.add(m.brushed, box(0.2, PRESS.baseY - base - 0.012, 0.012, 0.001), { p: [x, (PRESS.baseY + base + 0.012) / 2, side * 0.05] });
    for (const b of [-0.07, 0.07]) parts.add(m.brushed, hex(0.007, 0.006), { p: [x + b, jawY + jawH / 2 + 0.003, z] });
  }
  const endZ = d / 2 + 0.07;
  parts.add(m.blue, box(0.22, 0.045, 0.03, 0.006, 3), { p: [x, base + 0.012 + 0.0225, endZ] });
  for (const gx of [-0.085, 0.085]) {
    parts.add(m.chrome, cyl(0.0065, endZ + d / 2 + 0.02, 16), { p: [x + gx, base + 0.03, (endZ - d / 2) / 2 - 0.01], r: ALONG_Z }, "cyl");
  }
  parts.add(m.brushed, cyl(0.008, 0.1, 16), { p: [x, base + 0.035, endZ + 0.02], r: ALONG_Z }, "cyl");
  parts.add(m.brushed, cyl(0.006, 0.13, 16), { p: [x, base + 0.035, endZ + 0.07], r: ALONG_X }, "cyl");
  for (const s of [-1, 1]) parts.add(m.phenolic, new THREE.SphereGeometry(0.012, 16, 12), { p: [x + s * 0.065, base + 0.035, endZ + 0.07] });
}

// --------------------------------------------------------------------------------------------------- the machine

export interface PressModel {
  root: THREE.Group;
  quill: THREE.Group; // slides down by the quill travel
  spindle: THREE.Group; // chuck and bit: spins about y
  handle: THREE.Group; // feed handle: turns about x with the quill travel
  carriage: THREE.Group; // cross-slide: moves along x
  handwheel: THREE.Group; // cross-slide handwheel: turns about x
  samples: SampleView[];
  lcd: THREE.CanvasTexture;
  lamps: { power: Mat; spindle: Mat; stall: Mat };
}

export function buildPress(m: PressMaterials, specs: SampleSpec[]): PressModel {
  const root = new THREE.Group();
  const frame = new Parts();

  // base: hazard-striped plinth on levelling feet, painted deck, anchor bolts
  frame.add(m.hazard, box(0.6, 0.07, 0.8, 0.012, 3), { p: [0, 0.085, -0.24] });
  frame.add(m.paint, box(0.54, 0.02, 0.74, 0.006), { p: [0, 0.125, -0.24] });
  for (const fx of [-0.25, 0.25]) {
    for (const fz of [-0.58, 0.1]) {
      frame.add(m.rubber, cyl(0.045, 0.02, 32, 0.05), { p: [fx, 0.01, fz] }, "cyl");
      frame.add(m.brushed, cyl(0.012, 0.04, 16), { p: [fx, 0.035, fz] }, "cyl");
      frame.add(m.brushed, hex(0.022, 0.012), { p: [fx, 0.044, fz] });
      const ax = fx * 0.94, az = fz + (fz < 0 ? 0.04 : -0.04);
      frame.add(m.brushed, cyl(0.024, 0.004, 24), { p: [ax, 0.137, az] }, "cyl");
      frame.add(m.brushed, hex(0.016, 0.012), { p: [ax, 0.145, az] });
      frame.add(m.brushed, cyl(0.008, 0.014, 12), { p: [ax, 0.157, az] }, "cyl");
    }
  }
  // column on a raised pad and flange, with the table-raising rack along its right side
  frame.add(m.paint, box(0.3, 0.03, 0.3, 0.01, 3), { p: [0, 0.15, COL_Z] });
  frame.add(m.paint, cyl(0.1, 0.035, 48, 0.11), { p: [0, 0.1825, COL_Z] }, "cyl");
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    frame.add(m.brushed, hex(0.011, 0.01), { p: [Math.sin(a) * 0.082, 0.205, COL_Z + Math.cos(a) * 0.082] });
  }
  frame.add(m.chrome, cyl(0.05, 1.66, 48), { p: [0, 1.03, COL_Z] }, "cyl");
  frame.add(m.brushed, box(0.012, 1.2, 0.024, 0.001), { p: [0.056, 0.87, COL_Z] });
  for (let i = 0; i < 58; i++) frame.add(m.brushed, box(0.008, 0.007, 0.024, 0), { p: [0.066, 0.29 + i * 0.02, COL_Z] });
  frame.add(m.paint, cyl(0.066, 0.03, 40), { p: [0, 1.485, COL_Z] }, "cyl");

  // work table on its bracket, machined top with T-slots, lock lever and elevation crank
  frame.add(m.paint, cyl(0.08, 0.17, 48), { p: [0, 0.785, COL_Z] }, "cyl");
  frame.add(m.paint, box(0.13, 0.09, 0.3, 0.02, 3), { p: [0, 0.81, -0.15] });
  frame.add(m.paint, box(0.07, 0.1, 0.2, 0.012, 3), { p: [0, 0.73, -0.2], r: [0.35, 0, 0] });
  frame.add(m.paint, box(0.52, 0.045, 0.38, 0.01, 3), { p: [0, 0.8525, 0] });
  for (const [z0, z1] of [[-0.18, -0.125], [-0.105, 0.105], [0.125, 0.18]]) {
    frame.add(m.brushed, box(0.5, 0.008, z1 - z0, 0.0015), { p: [0, 0.879, (z0 + z1) / 2] });
  }
  for (const z of [-0.115, 0.115]) frame.add(m.graphite, box(0.5, 0.004, 0.02, 0), { p: [0, 0.877, z] });
  frame.add(m.brushed, cyl(0.007, 0.13, 16), { p: [-0.13, 0.79, COL_Z + 0.03], r: [0, -0.5, Math.PI / 2] }, "cyl");
  frame.add(m.phenolic, new THREE.SphereGeometry(0.017, 20, 14), { p: [-0.188, 0.79, COL_Z + 0.064] });
  frame.add(m.brushed, cyl(0.01, 0.07, 16), { p: [0.11, 0.77, COL_Z], r: ALONG_X }, "cyl");
  frame.add(m.graphite, box(0.014, 0.1, 0.02, 0.005), { p: [0.15, 0.73, COL_Z] });
  frame.add(m.phenolic, cyl(0.011, 0.055, 16), { p: [0.18, 0.69, COL_Z], r: ALONG_X }, "cyl");

  // cross-slide: saddle and ways on the table, leadscrew in front, the carriage rides on top
  frame.add(m.graphite, box(0.46, 0.022, 0.24, 0.006), { p: [0, 0.894, 0] });
  for (const z of [-0.085, 0.085]) frame.add(m.chrome, box(0.5, 0.014, 0.022, 0.003), { p: [0, 0.912, z] });
  frame.add(m.brushed, cyl(0.007, 0.56, 20), { p: [0.02, 0.905, 0.135], r: ALONG_X }, "cyl");
  for (const x of [-0.25, 0.28]) frame.add(m.graphite, box(0.03, 0.045, 0.035, 0.006), { p: [x, 0.9, 0.135] });

  const handwheel = new THREE.Group();
  handwheel.position.set(HANDWHEEL_X, 0.905, 0.135);
  const wheel = new Parts();
  wheel.add(m.fins, new THREE.TorusGeometry(0.055, 0.008, 12, 48), { r: [0, Math.PI / 2, 0] }, { u: 0.35, v: 0.05 });
  wheel.add(m.fins, cyl(0.016, 0.03, 24), { r: ALONG_X }, "cyl");
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    wheel.add(m.fins, box(0.008, 0.05, 0.01, 0.002), { p: [0, Math.cos(a) * 0.033, Math.sin(a) * 0.033], r: [a, 0, 0] });
  }
  wheel.add(m.phenolic, cyl(0.008, 0.045, 16, 0.009), { p: [0.03, 0.045, 0], r: ALONG_X }, "cyl");
  wheel.build(handwheel);

  const carriage = new THREE.Group();
  const slide = new Parts();
  slide.add(m.brushed, box(0.6, 0.034, 0.21, 0.004, 3), { p: [0, 0.936, 0] });
  for (const z of [-0.055, 0.055]) slide.add(m.graphite, box(0.6, 0.0015, 0.012, 0), { p: [0, CARRIAGE_TOP, z] });
  for (const x of [-0.3, 0.3]) slide.add(m.graphite, box(0.012, 0.03, 0.06, 0.003), { p: [x, 0.936, 0] });
  const pitch = PRESS.slotPitch;
  const samples = specs.map((s, i) => {
    const x = (i - (specs.length - 1) / 2) * pitch;
    vise(slide, m, x, sampleDepth(s.kind));
    return x;
  });
  slide.build(carriage);
  const sticker = stickerTexture(specs);
  const views = specs.map((s, i) => {
    const v = buildSample(s, i, specs.length, m, sticker);
    v.group.position.set(samples[i], PRESS.baseY, 0);
    carriage.add(v.group);
    return v;
  });

  // head: casting, quill nose, motor with cooling fins, belt cover, nameplate
  frame.add(m.paint, headCasting());
  frame.add(m.paint, cyl(0.072, 0.07, 48, 0.08), { p: [0, 1.56, 0] }, "cyl");
  frame.add(m.brushed, cyl(0.042, 0.006, 32), { p: [0, 1.523, 0] }, "cyl");
  for (const y of [1.66, 1.75]) frame.add(m.brushed, hex(0.012, 0.012), { p: [-0.142, y, COL_Z], r: ALONG_X });
  frame.add(m.paint, box(0.2, 0.03, 0.18, 0.008), { p: [0, 1.79, -0.47] });
  frame.add(m.graphite, cyl(0.09, 0.3, 48), { p: [0, 1.665, MOTOR_Z] }, "cyl");
  frame.add(m.graphite, new THREE.SphereGeometry(0.09, 48, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    { p: [0, 1.515, MOTOR_Z], s: [1, 0.35, 1] }, "cyl");
  frame.add(m.graphite, cyl(0.1, 0.02, 48), { p: [0, 1.805, MOTOR_Z] }, "cyl");
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    frame.add(m.fins, box(0.004, 0.24, 0.02, 0), { p: [Math.sin(a) * 0.098, 1.66, MOTOR_Z + Math.cos(a) * 0.098], r: [0, a, 0] });
  }
  frame.add(m.graphite, box(0.06, 0.09, 0.07, 0.008), { p: [-0.12, 1.62, MOTOR_Z] });
  frame.add(m.brushed, cyl(0.012, 0.025, 16, 0.014), { p: [-0.12, 1.565, MOTOR_Z] }, "cyl");
  frame.add(m.accent, beltCover(), { p: [0, 1.82, 0] });
  frame.add(m.phenolic, cyl(0.016, 0.02, 24, 0.019), { p: [0, 1.925, -0.08] }, "cyl");
  for (const z of [-0.12, -0.44]) frame.add(m.chrome, cyl(0.008, 0.03, 16), { p: [-0.135, 1.86, z], r: ALONG_Z }, "cyl");

  // feed handle boss on the head; the handle itself turns
  frame.add(m.paint, cyl(0.05, 0.03, 40, 0.056), { p: [0.135, FEED_HANDLE.y, FEED_HANDLE.z], r: ALONG_X }, "cyl");
  const handle = new THREE.Group();
  handle.position.copy(FEED_HANDLE);
  const hp = new Parts();
  hp.add(m.chrome, cyl(0.036, 0.05, 40), { p: [0.03, 0, 0], r: ALONG_X }, "cyl");
  hp.add(m.chrome, new THREE.SphereGeometry(0.036, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), { p: [0.055, 0, 0], r: [0, 0, -Math.PI / 2], s: [1, 0.4, 1] });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const dir = new THREE.Vector3(0.14, Math.cos(a), Math.sin(a)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
    const mid = dir.clone().multiplyScalar(0.13).add(new THREE.Vector3(0.04, 0, 0));
    hp.add(m.chrome, cyl(0.0085, 0.22, 16, 0.0075), { p: [mid.x, mid.y, mid.z], r: [e.x, e.y, e.z] }, "cyl");
    const end = dir.clone().multiplyScalar(0.245).add(new THREE.Vector3(0.04, 0, 0));
    hp.add(m.phenolic, new THREE.SphereGeometry(0.022, 24, 16), { p: [end.x, end.y, end.z] });
  }
  hp.build(handle);

  // quill, depth-stop rod and the spinning chuck and core bit
  const quill = new THREE.Group();
  const qp = new Parts();
  qp.add(m.chrome, cyl(0.034, 0.32, 48), { p: [0, 1.675, 0] }, "cyl");
  qp.add(m.brushed, cyl(0.038, 0.014, 40), { p: [0, 1.522, 0] }, "cyl");
  qp.add(m.graphite, box(0.07, 0.012, 0.024, 0.003), { p: [-0.05, 1.535, 0.02], r: [0, 0.35, 0] });
  qp.add(m.brushed, cyl(0.005, 0.3, 12), { p: [-0.082, 1.69, 0.032] }, "cyl");
  for (const y of [1.548, 1.562]) qp.add(m.knurl, cyl(0.011, 0.01, 16), { p: [-0.082, y, 0.032] }, "cyl");
  qp.build(quill);

  const spindle = new THREE.Group();
  const sp = new Parts();
  sp.add(m.brushed, lathe([[0.001, 1.442], [0.011, 1.442], [0.016, 1.449], [0.025, 1.458], [0.034, 1.466]]), {}, "cyl");
  sp.add(m.knurl, lathe([[0.034, 1.466], [0.041, 1.47], [0.041, 1.5], [0.036, 1.507], [0.03, 1.515]]), {}, "cyl");
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    sp.add(m.graphite, cyl(0.005, 0.006, 12), { p: [Math.sin(a) * 0.04, 1.485, Math.cos(a) * 0.04], r: [Math.PI / 2, a, 0] });
  }
  const tip = PRESS.homeTipY, barrel = 0.155;
  sp.add(m.brushed, cyl(0.008, 0.05, 20), { p: [0, 1.443 - 0.022, 0] }, "cyl");
  sp.add(m.brushed, cyl(0.008, 0.016, 32, BIT_R), { p: [0, tip + barrel + 0.004 + 0.008, 0] }, "cyl");
  sp.add(m.brushed, flutedBarrel(barrel), { p: [0, tip + 0.004, 0] }, { u: 2 * Math.PI * BIT_R, v: barrel });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    sp.add(m.carbide, box(0.0045, 0.008, 0.012, 0.0008, 1), { p: [Math.sin(a) * (BIT_R - 0.0015), tip + 0.004, Math.cos(a) * (BIT_R - 0.0015)], r: [0, a, 0] });
  }
  sp.build(spindle);
  quill.add(spindle);

  // pendant control panel on an arm off the head, angled up toward the operator
  const panel = new THREE.Group();
  panel.position.set(-0.29, 1.36, 0.14);
  panel.rotation.set(-0.55, 0.45, 0, "YXZ");
  const pp = new Parts();
  pp.add(m.graphite, box(0.2, 0.15, 0.065, 0.012, 3), { p: [0, 0, -0.0325] });
  pp.add(m.phenolic, box(0.11, 0.066, 0.008, 0.003), { p: [-0.03, 0.025, 0.002] });
  for (const lx of [-0.065, -0.03, 0.005]) pp.add(m.chrome, cyl(0.0095, 0.006, 24), { p: [lx, -0.035, 0.001], r: ALONG_Z }, "cyl");
  pp.add(m.yellow, cyl(0.033, 0.004, 40), { p: [0.06, 0.005, 0.002], r: ALONG_Z });
  pp.add(m.red, cyl(0.012, 0.016, 24), { p: [0.06, 0.005, 0.01], r: ALONG_Z });
  pp.add(m.red, lathe([[0.0, 0.03], [0.021, 0.027], [0.023, 0.021], [0.02, 0.017], [0.012, 0.016]], 40).rotateX(Math.PI / 2), { p: [0.06, 0.005, -0.004] });
  pp.build(panel);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.176, 0.126), new THREE.MeshStandardMaterial({ map: faceplateTexture(), roughness: 0.55, metalness: 0.2 }));
  face.position.z = 0.0004;
  const lcd = canvasTexture(256, 160, () => {});
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.096, 0.056), new THREE.MeshBasicMaterial({ map: lcd, toneMapped: false }));
  screen.position.set(-0.03, 0.025, 0.0065);
  const lamp = (color: number) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 0, roughness: 0.2 });
  const lamps = { power: lamp(0x39ff6a), spindle: lamp(0xffb020), stall: lamp(0xff2a1a) };
  [lamps.power, lamps.spindle, lamps.stall].forEach((mat, i) => {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    lens.rotation.x = Math.PI / 2;
    lens.scale.y = 0.6;
    lens.position.set([-0.065, -0.03, 0.005][i], -0.035, 0.004);
    panel.add(lens);
  });
  panel.add(face, screen);
  const armTop = new THREE.Vector3(0, 0.075, -0.03).applyEuler(panel.rotation).add(panel.position);
  const arm = tube([[-0.13, 1.66, 0.0], [-0.21, 1.63, 0.05], [-0.27, 1.52, 0.11], [armTop.x, armTop.y, armTop.z]], 0.011, 32);
  frame.add(m.brushed, arm[0], {}, arm[1]);
  frame.add(m.graphite, cyl(0.026, 0.02, 24, 0.03), { p: [-0.135, 1.66, 0], r: ALONG_X }, "cyl");

  // power cable from the panel down to the battery box beside the machine, outside the carriage's travel: with the
  // basalt under the bit the regolith's vise reaches x = -0.43
  const battery = new THREE.Group();
  battery.position.set(-0.86, 0, -0.3);
  battery.rotation.y = 0.3;
  const plug = new THREE.Vector3(0.2, 0.14, 0.02).applyEuler(battery.rotation).add(battery.position);
  const panelLow = new THREE.Vector3(0, -0.075, -0.03).applyEuler(panel.rotation).add(panel.position);
  const cable = tube([[panelLow.x, panelLow.y, panelLow.z], [-0.42, 1.24, 0.11], [-0.56, 1.06, 0.07], [-0.58, 0.62, 0.02],
    [-0.57, 0.12, -0.03], [-0.62, 0.012, -0.12], [plug.x + 0.06, 0.03, plug.z + 0.02], [plug.x + 0.015, plug.y, plug.z]], 0.011, 120);
  frame.add(m.rubber, cable[0], {}, cable[1]);
  frame.add(m.brushed, cyl(0.016, 0.03, 20), { p: [panelLow.x, panelLow.y - 0.01, panelLow.z] }, "cyl");

  const bp = new Parts();
  bp.add(m.foil, box(0.38, 0.26, 0.28, 0.02, 4), { p: [0, 0.15, 0] });
  bp.add(m.paint, box(0.4, 0.04, 0.3, 0.01, 3), { p: [0, 0.3, 0] });
  bp.add(m.hazard, box(0.402, 0.016, 0.302, 0.004), { p: [0, 0.275, 0] });
  for (const s of [-1, 1]) {
    for (const z of [-0.11, 0.11]) bp.add(m.rubber, cyl(0.022, 0.02, 20), { p: [s * 0.16, 0.01, z] }, "cyl");
    bp.add(m.brushed, new THREE.TorusGeometry(0.055, 0.007, 10, 24, Math.PI), { p: [s * 0.195, 0.2, 0], r: [0, Math.PI / 2, 0] }, { u: 0.17, v: 0.044 });
  }
  bp.add(m.brushed, cyl(0.02, 0.03, 24), { p: [0.2, 0.14, 0.02], r: ALONG_X }, "cyl");
  bp.build(battery);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.11), new THREE.MeshStandardMaterial({ map: batteryLabel(), roughness: 0.6 }));
  label.position.set(0, 0.16, 0.1415);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshStandardMaterial({ color: 0x113311, emissive: 0x39ff6a, emissiveIntensity: 2.5 }));
  led.position.set(0.15, 0.25, 0.141);
  battery.add(label, led);

  // operator's tread plate
  frame.add(m.hazard, box(0.84, 0.028, 0.64, 0.006), { p: [0, 0.014, 0.62] });
  frame.add(m.tread, box(0.76, 0.012, 0.56, 0.003, 1), { p: [0, 0.031, 0.62] });

  frame.build(root);
  const nameplate = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.06), new THREE.MeshStandardMaterial({ map: nameplateTexture(), roughness: 0.4, metalness: 0.6 }));
  nameplate.position.set(0.1395, 1.88, -0.28);
  nameplate.rotation.y = Math.PI / 2;
  const warning = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.09), new THREE.MeshStandardMaterial({ map: warningTexture(), roughness: 0.5 }));
  warning.position.set(0, 1.672, 0.1168); // on the head's front face, above the quill
  root.add(carriage, handwheel, handle, quill, panel, battery, nameplate, warning);
  return { root, quill, spindle, handle, carriage, handwheel, samples: views, lcd, lamps };
}

// --------------------------------------------------------------------------------------------------- decals

function faceplateTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 366, (g) => {
    g.fillStyle = "#2b2d31";
    g.fillRect(0, 0, 512, 366);
    g.strokeStyle = "#55585e";
    g.lineWidth = 4;
    g.strokeRect(6, 6, 500, 354);
    g.fillStyle = "#d9d6cc";
    g.font = "bold 22px system-ui, sans-serif";
    g.textAlign = "center";
    // lamp captions under the three lamps (panel x -0.065, -0.03, 0.005 -> canvas)
    [["PWR", -0.065], ["SPIN", -0.03], ["STALL", 0.005]].forEach(([t, x]) => g.fillText(t as string, (0.088 + (x as number)) / 0.176 * 512, 300));
    g.fillText("E-STOP", (0.088 + 0.06) / 0.176 * 512, 300);
    g.font = "bold 20px system-ui, sans-serif";
    g.fillStyle = "#f2b705";
    g.fillText("LH-1 FEED CONTROL", 128 + 60, 34);
    g.font = "16px system-ui, sans-serif";
    g.fillStyle = "#a9a59a";
    g.fillText("FIST ▼ LOWER   ·   OPEN ▲ RAISE", 256, 340);
  });
}

function nameplateTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, 180, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 180);
    grad.addColorStop(0, "#cfd2d4");
    grad.addColorStop(1, "#8f9497");
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 180);
    g.fillStyle = "#1b1c1f";
    g.fillRect(10, 10, 1004, 160);
    g.fillStyle = "#e9e4d6";
    g.font = "bold 74px system-ui, sans-serif";
    g.fillText("LH-1", 40, 112);
    g.font = "bold 40px system-ui, sans-serif";
    g.fillText("LUNAR CORE SAMPLING PRESS", 250, 86);
    g.font = "26px system-ui, sans-serif";
    g.fillStyle = "#f08a2a";
    g.fillText("SHACKLETON RIM WORK SITE · 28 V DC · 450 RPM MAX", 250, 132);
  });
}

function warningTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 256, (g) => {
    g.fillStyle = "#f2b705";
    g.fillRect(0, 0, 512, 256);
    g.lineWidth = 12;
    g.strokeStyle = "#16171a";
    g.strokeRect(10, 10, 492, 236);
    g.beginPath(); // warning triangle
    g.moveTo(100, 44); g.lineTo(172, 180); g.lineTo(28, 180); g.closePath();
    g.lineWidth = 10; g.lineJoin = "round"; g.stroke();
    g.fillStyle = "#16171a";
    g.textAlign = "center";
    g.font = "bold 92px system-ui, sans-serif";
    g.fillText("!", 100, 168);
    g.textAlign = "left";
    g.font = "bold 38px system-ui, sans-serif";
    g.fillText("ROTATING BIT", 196, 92);
    g.font = "bold 30px system-ui, sans-serif";
    g.fillText("KEEP HANDS CLEAR", 196, 138);
    g.font = "24px system-ui, sans-serif";
    g.fillText("Raise the bit before", 196, 182);
    g.fillText("moving the table", 196, 214);
  });
}

function batteryLabel(): THREE.CanvasTexture {
  return canvasTexture(512, 216, (g) => {
    g.fillStyle = "#efece3";
    g.fillRect(0, 0, 512, 216);
    g.fillStyle = "#16171a";
    g.fillRect(0, 0, 512, 52);
    g.fillStyle = "#f2b705";
    g.font = "bold 34px system-ui, sans-serif";
    g.fillText("LH-PWR-2  BATTERY", 18, 38);
    g.fillStyle = "#16171a";
    g.font = "bold 40px system-ui, sans-serif";
    g.fillText("28 V DC · 4.2 kWh", 18, 110);
    g.font = "24px system-ui, sans-serif";
    g.fillText("Li-ion · keep clear of regolith dust", 18, 150);
    g.beginPath(); // warning triangle
    g.moveTo(440, 120); g.lineTo(490, 200); g.lineTo(390, 200); g.closePath();
    g.fillStyle = "#f2b705"; g.fill();
    g.lineWidth = 6; g.strokeStyle = "#16171a"; g.stroke();
    g.fillStyle = "#16171a";
    g.font = "bold 52px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("!", 440, 192);
  });
}
