import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Rock } from "./detail";
import { rockGeometry, Rocks } from "./rocks";

describe("rocks", () => {
  it("are irregular stones fitted to the unit cube, the same for the same seed", () => {
    const a = rockGeometry(11, 4), b = rockGeometry(11, 4), c = rockGeometry(12, 4);
    expect(a.getAttribute("position").count).toBe(20 * 25 * 3); // non-indexed: normals split along fracture edges
    for (const v of ["x", "y", "z"] as const) {
      expect(a.boundingBox!.min[v]).toBeCloseTo(-1, 5);
      expect(a.boundingBox!.max[v]).toBeCloseTo(1, 5);
    }
    expect(Array.from(b.getAttribute("position").array)).toEqual(Array.from(a.getAttribute("position").array));
    expect(Array.from(c.getAttribute("position").array)).not.toEqual(Array.from(a.getAttribute("position").array));
  });

  it("stand h above the ground and draw the near ones in detail, far small ones not at all", () => {
    const ground = (x: number, _z: number) => 0.01 * x + 2;
    const rocks: Rock[] = [];
    for (let i = 0; i < 400; i++) rocks.push({ x: (i % 20) * 25 - 250, z: Math.floor(i / 20) * 25 - 250, r: 0.15 + (i % 7) * 0.1, h: 0.2, rot: i });
    const set = new Rocks(rocks, ground);
    set.update(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 2, 0));
    const meshes = set.children as THREE.InstancedMesh[];
    const detailed = (m: THREE.InstancedMesh) => m.geometry.getAttribute("position").count > 3000;
    const drawn = (pick: (m: THREE.InstancedMesh) => boolean) => {
      const out: THREE.Vector3[] = [];
      const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      for (const m of meshes.filter(pick)) {
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, m4);
          m4.decompose(p, q, s);
          expect(p.y + s.y).toBeCloseTo(ground(p.x, p.z) + 0.2, 5); // top of the model at h
          out.push(p.clone());
        }
      }
      return out;
    };
    const near = drawn(detailed), far = drawn((m) => !detailed(m));
    const within = (r: number) => rocks.filter((k) => Math.hypot(k.x, k.z) < r).length;
    expect(near.length).toBe(within(30));
    for (const p of far) expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(30);
    expect(near.length + far.length).toBeGreaterThanOrEqual(within(80));
    expect(near.length + far.length).toBeLessThan(rocks.length);
  });
});
