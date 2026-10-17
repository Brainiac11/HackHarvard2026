import { describe, expect, it } from "vitest";
import { GestureState, HandednessFilter, normalizedCurls, palmRollDeg, rawCurls } from "./gestures";
import { OneEuro } from "./oneEuro";

/** Synthetic world landmarks: each finger continues along its metacarpal and curls toward the palm (+z). */
function hand(bends: number[], roll = 0): number[][] {
  const pts: number[][] = Array.from({ length: 21 }, () => [0, 0, 0]);
  const mcpX = [-0.035, -0.025, 0, 0.022, 0.042];
  const boneLen = [0.035, 0.025, 0.02];
  for (let f = 0; f < 5; f++) {
    const base = 1 + f * 4;
    // thumb: CMC then MCP define its "metacarpal"; fingers: wrist -> MCP
    const from = f === 0 ? [-0.02, -0.025, 0] : [0, 0, 0];
    const mcp = f === 0 ? [mcpX[0], -0.05, 0] : [mcpX[f], -0.07, 0];
    if (f === 0) pts[base] = from;
    const first = f === 0 ? base + 1 : base;
    pts[first] = mcp;
    const ux = mcp[0] - from[0], uy = mcp[1] - from[1];
    const ul = Math.hypot(ux, uy);
    let dir = 0, [x, y, z] = mcp;
    for (let j = 0; j < (f === 0 ? 2 : 3); j++) {
      dir += bends[f];
      x += boneLen[j] * Math.cos(dir) * (ux / ul);
      y += boneLen[j] * Math.cos(dir) * (uy / ul);
      z += boneLen[j] * Math.sin(dir);
      pts[first + j + 1] = [x, y, z];
    }
  }
  const c = Math.cos(roll), s = Math.sin(roll);
  return pts.map(([x, y, z]) => [x * c - y * s, x * s + y * c, z]);
}

const OPEN = hand([0, 0, 0, 0, 0]);
const FIST = hand([0.6, 1.1, 1.1, 1.1, 1.1]);
const POINT = hand([0.6, 0, 1.1, 1.1, 1.1]); // index straight, others curled (trigger released)

describe("finger curl", () => {
  it("is near zero for an open hand and large for a fist", () => {
    expect(Math.max(...rawCurls(OPEN))).toBeLessThan(0.05);
    expect(Math.min(...rawCurls(FIST).slice(1))).toBeGreaterThan(3);
    expect(rawCurls(FIST)[0]).toBeGreaterThan(1);
  });
  it("normalizes into 0..1", () => {
    const open = normalizedCurls(OPEN), fist = normalizedCurls(FIST);
    open.forEach((c) => expect(c).toBe(0));
    fist.slice(1).forEach((c) => expect(c).toBeGreaterThan(0.95));
  });
});

describe("gestures", () => {
  it("grip with hysteresis and index trigger", () => {
    const g = new GestureState();
    expect(g.update(normalizedCurls(POINT), 0)).toMatchObject({ grip: true, trigger: 0 });
    expect(g.update(normalizedCurls(FIST), 0.1).trigger).toBeGreaterThan(0.9);
    // partially relaxed fist stays gripped (hysteresis)
    const relaxed = normalizedCurls(hand([0.3, 0.6, 0.55, 0.55, 0.55]));
    expect(g.update(relaxed, 0.2).grip).toBe(true);
    expect(g.update(normalizedCurls(OPEN), 0.3).grip).toBe(false);
  });
  it("open palm needs 200 ms", () => {
    const g = new GestureState();
    expect(g.update(normalizedCurls(OPEN), 0).openPalm).toBe(false);
    expect(g.update(normalizedCurls(OPEN), 0.25).openPalm).toBe(true);
  });
  it("palm roll tracks rotation", () => {
    expect(Math.abs(palmRollDeg(OPEN, "Right"))).toBeLessThan(1);
    expect(palmRollDeg(hand([0, 0, 0, 0, 0], 0.5), "Right")).toBeCloseTo(28.6, 0);
  });
  it("a glove-limited fist grips only with the wearer's calibration", () => {
    const gloveFist = hand([0.3, 0.55, 0.55, 0.55, 0.55]); // thick glove: fingers stop about half way
    expect(new GestureState().update(normalizedCurls(gloveFist), 0).grip).toBe(false);
    const cal = { open: rawCurls(OPEN).map((c) => c + 0.1), closed: rawCurls(gloveFist) };
    expect(new GestureState().update(normalizedCurls(gloveFist, cal), 0).grip).toBe(true);
  });
});

describe("HandednessFilter", () => {
  it("ignores brief Left/Right flips and follows a sustained change", () => {
    const h = new HandednessFilter(3);
    expect(h.update("Right")).toBe("Right");
    expect(h.update("Left")).toBe("Right");
    expect(h.update("Left")).toBe("Right");
    expect(h.update("Right")).toBe("Right"); // streak broken
    ["Left", "Left"].forEach((l) => expect(h.update(l)).toBe("Right"));
    expect(h.update("Left")).toBe("Left");
  });
});

describe("OneEuro", () => {
  it("smooths noise at rest and follows a step", () => {
    const f = new OneEuro(1.2, 0.02);
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter(1 + (i % 2 ? 0.01 : -0.01), i / 30);
    expect(Math.abs(out - 1)).toBeLessThan(0.01);
    for (let i = 60; i < 120; i++) out = f.filter(2, i / 30);
    expect(out).toBeGreaterThan(1.95);
  });
});
