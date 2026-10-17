import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { acquireTarget } from "./drill";

const deg = THREE.MathUtils.degToRad;
const eye = new THREE.Vector3(0, 0, 0);
const toward = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

function block(x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  m.position.set(x, y, z);
  m.updateMatrixWorld();
  return m;
}

describe("drill aim assist", () => {
  it("takes a direct hit on the face it strikes", () => {
    const hit = acquireTarget(eye, toward(0, 0, -1), [block(0, 0, -2)], 12, deg(6))!;
    expect(hit.index).toBe(0);
    expect(hit.distance).toBeCloseTo(1.75, 5);
    expect(hit.normal.z).toBeCloseTo(1, 5);
  });

  it("snaps a near miss onto the block's nearest edge", () => {
    // passes ~0.1 m wide of the block, about 2.6° off its edge
    const hit = acquireTarget(eye, toward(0.35, 0, -2), [block(0, 0, -2)], 12, deg(6))!;
    expect(hit.index).toBe(0);
    expect(hit.point.x).toBeGreaterThan(0.2);
    expect(hit.point.x).toBeLessThanOrEqual(0.25 + 1e-6);
  });

  it("ignores a wide miss unless that block is already held", () => {
    const dir = toward(0.75, 0, -2); // ~12° off the block's edge
    const blocks = [block(0, 0, -2)];
    expect(acquireTarget(eye, dir, blocks, 12, deg(6))).toBeNull();
    expect(acquireTarget(eye, dir, blocks, 12, deg(6), 0, deg(15))?.index).toBe(0);
  });

  it("picks the block closest to the aim", () => {
    const blocks = [block(-1, 0, -2), block(0.6, 0, -2)];
    expect(acquireTarget(eye, toward(0.2, 0, -1), blocks, 12, deg(6))?.index).toBe(1);
  });

  it("ignores blocks behind the eye or beyond sight", () => {
    expect(acquireTarget(eye, toward(0, 0, -1), [block(0, 0, 2)], 12, deg(6))).toBeNull();
    expect(acquireTarget(eye, toward(0.05, 0, -1), [block(0, 0, -20)], 12, deg(6))).toBeNull();
  });
});
