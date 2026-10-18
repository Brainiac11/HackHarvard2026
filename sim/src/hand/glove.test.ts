import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CapsuleBatch, Glove } from "./glove";

/** A synthetic right hand in camera space (metres, 0.45 m ahead), back of the hand toward the eye, fingers up. */
function rightHand(bend: number): THREE.Vector3[] {
  const pts = Array.from({ length: 21 }, () => new THREE.Vector3());
  const mcpX = [-0.035, -0.025, 0, 0.022, 0.042], bone = [0.035, 0.025, 0.02];
  for (let f = 0; f < 5; f++) {
    const first = f === 0 ? 2 : 1 + f * 4;
    if (f === 0) pts[1].set(-0.02, 0.025, 0);
    pts[first].set(mcpX[f], f === 0 ? 0.05 : 0.07, 0);
    const from = f === 0 ? pts[1] : pts[0];
    const u = new THREE.Vector3().subVectors(pts[first], from).normalize();
    let dir = 0;
    for (let j = 0; j < (f === 0 ? 2 : 3); j++) {
      dir += bend;
      // fingers curl toward the palm, which faces away from the eye (-z)
      pts[first + j + 1].copy(pts[first + j]).addScaledVector(u, bone[j] * Math.cos(dir)).add(
        new THREE.Vector3(0, 0, -bone[j] * Math.sin(dir)));
    }
  }
  return pts.map((p) => p.add(new THREE.Vector3(0.05, -0.05, -0.45)));
}
const mirror = (pts: THREE.Vector3[]) => pts.map((p) => new THREE.Vector3(-p.x, p.y, p.z));

const positions = (m: THREE.Mesh) => m.geometry.getAttribute("position") as THREE.BufferAttribute;
const normals = (m: THREE.Mesh) => m.geometry.getAttribute("normal") as THREE.BufferAttribute;

describe("capsule batch", () => {
  it("puts every vertex on the tapered capsule, with outward unit normals", () => {
    const batch = new CapsuleBatch(1, new THREE.MeshBasicMaterial(), () => new THREE.Color());
    const a = new THREE.Vector3(0.01, 0.02, -0.4), b = new THREE.Vector3(0.03, 0.06, -0.42);
    batch.set(0, a, b, 0.012, 0.009, new THREE.Vector3(0, 0, 1));
    const seg = new THREE.Line3(a, b), p = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3();
    const pos = positions(batch.mesh), nrm = normals(batch.mesh);
    for (let i = 0; i < pos.count; i++) {
      seg.closestPointToPoint(p.fromBufferAttribute(pos, i), true, q);
      const d = p.distanceTo(q);
      expect(d).toBeGreaterThan(0.009 * 0.98);
      expect(d).toBeLessThan(0.012 * 1.02);
      expect(n.fromBufferAttribute(nrm, i).length()).toBeCloseTo(1, 5);
      expect(n.dot(p.sub(q).normalize())).toBeGreaterThan(0.95);
    }
  });
});

describe("glove", () => {
  for (const [label, side, pts] of [["right", 1, rightHand(0.1)], ["left", -1, mirror(rightHand(0.1))]] as const) {
    it(`covers the ${label} palm with fabric on the back and rubber on the palm side`, () => {
      const glove = new Glove();
      glove.fit(pts, side);
      const palm = glove.group.getObjectByName("glove.palm") as THREE.Mesh;
      const pos = positions(palm), nrm = normals(palm), half = pos.count / 2;
      // the palm faces away from the eye (-z); the back of the hand toward it
      const mean = (from: number, to: number, attr: THREE.BufferAttribute) => {
        let z = 0;
        for (let i = from; i < to; i++) z += attr.getZ(i);
        return z / (to - from);
      };
      expect(mean(0, half, nrm)).toBeGreaterThan(0.4); // back-of-hand group: normals toward the eye
      expect(mean(half, pos.count, nrm)).toBeLessThan(-0.4); // palm group
      expect(mean(0, half, pos)).toBeGreaterThan(mean(half, pos.count, pos));
      expect(palm.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    });
  }

  it("follows a fist and lights the fingertips with the motors", () => {
    const glove = new Glove();
    glove.fit(rightHand(1.1), 1);
    const fabric = glove.group.getObjectByName("glove.fabric") as THREE.Mesh;
    const pos = positions(fabric);
    for (let i = 0; i < pos.count; i++) expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
    const rubber = glove.group.getObjectByName("glove.rubber") as THREE.Mesh<THREE.BufferGeometry,
      THREE.MeshStandardMaterial>;
    glove.showMotors([0, 1, 0.25, 0, 0]);
    const texels = rubber.material.emissiveMap!.image.data as Uint8Array;
    expect(texels[0]).toBe(0); // thumb off
    expect(texels[4]).toBe(255); // index fully lit (red channel of an orange glow)
    expect(texels[8]).toBeGreaterThan(0); // middle partly lit
    expect(texels[8]).toBeLessThan(texels[4]);
    expect(texels[20]).toBe(0); // the pads' texel never lights
  });
});
