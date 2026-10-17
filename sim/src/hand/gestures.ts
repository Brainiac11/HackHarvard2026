// Finger curl and gestures from MediaPipe world landmarks (PLAN.md §9.5). Pure functions: unit-tested.
export type Vec3 = [number, number, number];

// joint chains per finger (thumb uses CMC->MCP->IP->TIP)
export const CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
];
export const TIPS = [4, 8, 12, 16, 20];

const sub = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]) || 1e-9;
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b)))));

/** Raw flexion per finger: sum of angles between consecutive bones (radians). ~0 straight, ~2.5-3.5 fist. */
export function rawCurls(w: number[][]): number[] {
  return CHAINS.map((chain, f) => {
    let total = 0;
    // thumb: skip the wrist->CMC bend, it's mostly abduction
    for (let i = f === 0 ? 2 : 1; i < chain.length - 1; i++) {
      total += angle(sub(w[chain[i]], w[chain[i - 1]]), sub(w[chain[i + 1]], w[chain[i]]));
    }
    return total;
  });
}

export interface CurlCalibration { open: number[]; closed: number[] }
export const DEFAULT_CALIBRATION: CurlCalibration = {
  open: [0.35, 0.3, 0.3, 0.3, 0.35],
  closed: [1.4, 3.0, 3.2, 3.2, 3.0],
};

export function normalizedCurls(w: number[][], cal: CurlCalibration = DEFAULT_CALIBRATION): number[] {
  return rawCurls(w).map((c, i) => Math.min(1, Math.max(0, (c - cal.open[i]) / Math.max(0.2, cal.closed[i] - cal.open[i]))));
}

/** Palm roll in degrees from the knuckle line (index MCP -> pinky MCP), in the image plane. 0 = level. */
export function palmRollDeg(w: number[][], hand: string): number {
  const lat = sub(w[17], w[5]);
  const deg = (Math.atan2(lat[1], lat[0]) * 180) / Math.PI; // y down
  const level = hand === "Left" ? 180 : 0; // knuckle line points the other way on a left hand
  let d = deg - level;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** MediaPipe's Left/Right call is unreliable on a gloved hand and can flip frame to frame, which would flip the
 *  steering roll by 180°. Keep the current label until the other one wins `switchAfter` frames in a row. */
export class HandednessFilter {
  label: string | null = null;
  private streak = 0;
  constructor(private switchAfter = 12) {}

  update(raw: string): string {
    if (this.label === null || raw === this.label) {
      this.label = raw;
      this.streak = 0;
    } else if (++this.streak >= this.switchAfter) {
      this.label = raw;
      this.streak = 0;
    }
    return this.label;
  }
}

export function hysteresis(prev: boolean, value: number, on: number, off: number): boolean {
  return prev ? value > off : value > on;
}

export class GestureState {
  grip = false;
  openPalm = false;
  private openSince = -1;

  update(curls: number[], t: number): { grip: boolean; trigger: number; openPalm: boolean } {
    const gripValue = (curls[2] + curls[3] + curls[4]) / 3;
    this.grip = hysteresis(this.grip, gripValue, 0.65, 0.45);
    const allOpen = curls.every((c) => c < 0.25);
    if (allOpen) {
      if (this.openSince < 0) this.openSince = t;
    } else this.openSince = -1;
    this.openPalm = allOpen && t - this.openSince >= 0.2;
    const trigger = this.grip ? Math.min(1, Math.max(0, (curls[1] - 0.3) / 0.5)) : 0;
    return { grip: this.grip, trigger, openPalm: this.openPalm };
  }
}
