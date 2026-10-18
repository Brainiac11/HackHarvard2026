import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clearOf, TrackedHand, type KeepOut } from "./handModel";

/** A synthetic right hand in MediaPipe world axes (m, x right, y down), fingers up, slightly curled. */
function worldHand(): number[][] {
  const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
  const mcpX = [-0.035, -0.025, 0, 0.022, 0.042];
  for (let f = 0; f < 5; f++) {
    const first = f === 0 ? 2 : 1 + f * 4;
    if (f === 0) pts[1] = [-0.02, -0.025, 0];
    pts[first] = [mcpX[f], f === 0 ? -0.05 : -0.07, 0];
    for (let j = 1; j <= (f === 0 ? 2 : 3); j++) pts[first + j] = [mcpX[f], pts[first][1] - 0.025 * j, 0.004 * j];
  }
  return pts;
}

/** A frame with the hand centred at (u, v) in the phone's image. */
function frame(u: number, v: number) {
  const wlm = worldHand();
  return { t: "hand.frame" as const, ts: 0, hand: "Right", score: 1, fps: 30, wlm,
    lm: wlm.map(([x, y, z]) => [u + x * 2.2, v + y * 2.2, z]) };
}

/** The glove's horizontal extent on screen, as fractions of the view. */
function screenSpan(hand: TrackedHand, camera: THREE.PerspectiveCamera): [number, number] {
  hand.group.updateMatrixWorld(true);
  let lo = 1, hi = 0;
  const p = new THREE.Vector3();
  hand.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(camera);
      lo = Math.min(lo, (p.x + 1) / 2);
      hi = Math.max(hi, (p.x + 1) / 2);
    }
  });
  return [lo, hi];
}

describe("tracked glove", () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.03, 100);
  camera.updateMatrixWorld();

  it("stays where the hand is without a keep-out box, and steps beside one", () => {
    const free = new TrackedHand(camera);
    free.onFrame(frame(0.52, 0.6));
    const [lo, hi] = screenSpan(free, camera);
    expect((lo + hi) / 2).toBeGreaterThan(0.4);
    expect((lo + hi) / 2).toBeLessThan(0.65);

    const box: KeepOut = { u0: 0.3, u1: 0.7, v0: 0.2, v1: 0.8 };
    const kept = new TrackedHand(camera);
    kept.keepOut = box;
    kept.onFrame(frame(0.52, 0.6)); // the first frame after a gap places it at once
    const [klo, khi] = screenSpan(kept, camera);
    expect(klo > box.u1 - 0.02 || khi < box.u0 + 0.02).toBe(true);
  });

  it("is drawn only while tracked and not hidden", () => {
    const hand = new TrackedHand(camera);
    hand.update();
    expect(hand.group.visible).toBe(false);
    hand.onFrame(frame(0.5, 0.5));
    hand.update();
    expect(hand.group.visible).toBe(true);
    hand.hidden = true; // chase view: the hand still drives the rover
    hand.update();
    expect(hand.group.visible).toBe(false);
    expect(hand.active).toBe(true);
  });
});

describe("keep-out placement", () => {
  const box: KeepOut = { u0: 0.4, u1: 0.6, v0: 0.2, v1: 0.8 };
  const ext = { x0: -0.05, x1: 0.05, y0: -0.1, y1: 0.1 };
  const place = ([u, side]: [number, number], at: number, onSide: number) => {
    expect(u).toBeCloseTo(at, 9);
    expect(side).toBe(onSide);
  };

  it("leaves a hand clear of the box alone", () => {
    expect(clearOf(0.2, 0.5, ext, box, 0)).toEqual([0.2, 0]);
    expect(clearOf(0.5, 0.05, ext, box, 0)).toEqual([0.5, 0]); // above it
    expect(clearOf(0.5, 0.5, ext, null, 0)).toEqual([0.5, 0]);
  });

  it("puts an overlapping hand just beside the nearer side", () => {
    place(clearOf(0.47, 0.5, ext, box, 0), 0.35, -1);
    place(clearOf(0.53, 0.5, ext, box, 0), 0.65, 1);
  });

  it("doesn't flip sides while the hand hovers around the middle", () => {
    place(clearOf(0.53, 0.5, ext, box, -1), 0.35, -1);
    place(clearOf(0.47, 0.5, ext, box, 1), 0.65, 1);
    place(clearOf(0.58, 0.5, ext, box, -1), 0.65, 1); // clearly nearer the other side
  });
});
