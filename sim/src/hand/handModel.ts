// Virtual suit glove driven by the phone tracker (PLAN.md §9.5). Rendered in camera space: the head-mounted
// phone is roughly the astronaut's eye, so the hand appears where they see their real hand.
import * as THREE from "three";
import type { HandFrame } from "../net/messages";
import { DEFAULT_CALIBRATION, GestureState, normalizedCurls, rawCurls, type CurlCalibration, type HandPose }
  from "./gestures";
import { Glove } from "./glove";
import { OneEuro, OneEuroPoints } from "./oneEuro";

const PHONE_HFOV_DEG = 65; // approx. iPhone main camera horizontal FOV at 4:3
const HAND_LENGTH_M = 0.09; // wrist -> middle MCP, used for depth from apparent size
const MIN_DEPTH = 0.28, MAX_DEPTH = 0.65;
const STALE_S = 0.5;
// keeping out of a box: the cuff's solid length beyond the wrist (glove.ts), padding for finger and cuff thickness, how
// much nearer the other side must be before the glove crosses over, and how quickly it glides there (time constant)
const CUFF_M = 0.13, PAD_M = 0.04, SIDE_HYSTERESIS = 0.08, GLIDE_S = 0.08;

/** A box on screen (fractions of the view: u right, v down) the glove keeps out of, so it doesn't hide the work. */
export interface KeepOut { u0: number; u1: number; v0: number; v1: number }

/**
 * Where to centre a hand that sits at (u, v) with extent [u + x0, u + x1] × [v + y0, v + y1] so that it stays clear of
 * `box`: where it is, or just beside the box. It goes to the nearer side, but stays on `side` (-1 left, 1 right, as
 * returned last time; 0: none) until the other one is clearly nearer. Returns [u, side].
 */
export function clearOf(u: number, v: number, ext: { x0: number; x1: number; y0: number; y1: number },
  box: KeepOut | null, side: number): [number, number] {
  if (!box) return [u, 0];
  if (u + ext.x1 <= box.u0 || u + ext.x0 >= box.u1 || v + ext.y1 <= box.v0 || v + ext.y0 >= box.v1) return [u, 0];
  const left = box.u0 - ext.x1, right = box.u1 - ext.x0, toLeft = u - left, toRight = right - u;
  const go = side < 0 ? (toLeft > toRight + SIDE_HYSTERESIS ? 1 : -1)
    : side > 0 ? (toRight > toLeft + SIDE_HYSTERESIS ? -1 : 1) : toLeft <= toRight ? -1 : 1;
  return [go < 0 ? left : right, go];
}

/** The hand's extent (m) around its landmarks' origin, cuff included, in MediaPipe world axes (x right, y down). */
function handExtent(wlm: number[][]): { x0: number; x1: number; y0: number; y1: number } {
  // the cuff runs from the wrist away from the knuckles, drooping toward the body, as the glove poses it
  const w = wlm[0], m = wlm[9], l = Math.hypot(w[0] - m[0], w[1] - m[1], w[2] - m[2]) || 1;
  const dx = (w[0] - m[0]) / l, dy = (w[1] - m[1]) / l + 0.3, dz = (w[2] - m[2]) / l - 0.15;
  const k = CUFF_M / (Math.hypot(dx, dy, dz) || 1);
  let x0 = w[0] + dx * k, x1 = x0, y0 = w[1] + dy * k, y1 = y0;
  for (const p of wlm) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  return { x0: x0 - PAD_M, x1: x1 + PAD_M, y0: y0 - PAD_M, y1: y1 + PAD_M };
}

export class TrackedHand {
  readonly group = new THREE.Group();
  private glove = new Glove();
  private side = 1; // +1 right hand, -1 left: which face of the knuckle plane is the palm
  private filter = new OneEuroPoints(1.2, 0.02);
  // image-space hand centre (0..1): steady at rest, quick when the hand sweeps across the view
  private centerU = new OneEuro(1.5, 4);
  private centerV = new OneEuro(1.5, 4);
  private gestures = new GestureState();
  private lastFrame = -1e9;
  private lastDepth = 0.45;
  private shownU = 0.5; // where the glove is drawn across the view: the hand's place, or beside the keep-out box
  private keepSide = 0;
  private points: THREE.Vector3[] = Array.from({ length: 21 }, () => new THREE.Vector3());
  calibration: CurlCalibration = structuredClone(DEFAULT_CALIBRATION);
  curls = [0, 0, 0, 0, 0];
  raw = [0, 0, 0, 0, 0];
  grip = false;
  openPalm = false;
  pose: HandPose = "neutral"; // fist / open hand / neither: the drill press feed and the rover throttle
  closure = 0; // mean curl of index..pinky, 0 open .. 1 fist
  fps = 0;
  hidden = false; // third-person views: the hand still drives, but no glove is drawn
  keepOut: KeepOut | null = null;

  constructor(private camera: THREE.PerspectiveCamera) {
    this.group.add(this.glove.group);
    this.group.visible = false;
    camera.add(this.group);
  }

  get active(): boolean { return performance.now() / 1000 - this.lastFrame < STALE_S; }

  onFrame(f: HandFrame): void {
    if (f.lm.length !== 21 || f.wlm.length !== 21) return;
    const t = performance.now() / 1000, dt = t - this.lastFrame;
    this.lastFrame = t;
    this.fps = f.fps;
    const wlm = this.filter.filter(f.wlm, t);

    // depth from apparent hand size (image) vs metric size (world landmarks)
    const imgSize = Math.hypot(f.lm[9][0] - f.lm[0][0], f.lm[9][1] - f.lm[0][1]);
    const tanH = Math.tan(THREE.MathUtils.degToRad(PHONE_HFOV_DEG / 2));
    const depth = THREE.MathUtils.clamp(HAND_LENGTH_M / Math.max(1e-3, imgSize * 2 * tanH), MIN_DEPTH, MAX_DEPTH);
    this.lastDepth = THREE.MathUtils.lerp(this.lastDepth, depth, 0.35);

    // hand centre in the sim camera's frustum at that depth
    const cu = this.centerU.filter(f.lm.reduce((s, p) => s + p[0], 0) / 21, t);
    const cv = this.centerV.filter(f.lm.reduce((s, p) => s + p[1], 0) / 21, t);
    const vTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // beside the keep-out box if it would cover it: the glove glides there rather than jumping
    const kU = 1 / (2 * this.lastDepth * vTan * this.camera.aspect), kV = 1 / (2 * this.lastDepth * vTan);
    const e = handExtent(wlm);
    const [u, side] = clearOf(cu, cv, { x0: e.x0 * kU, x1: e.x1 * kU, y0: e.y0 * kV, y1: e.y1 * kV }, this.keepOut,
      this.keepSide);
    this.keepSide = side;
    this.shownU = dt > STALE_S ? u : this.shownU + (u - this.shownU) * (1 - Math.exp(-dt / GLIDE_S));
    const center = new THREE.Vector3((this.shownU - 0.5) * 2 * this.lastDepth * vTan * this.camera.aspect,
      -(cv - 0.5) * 2 * this.lastDepth * vTan, -this.lastDepth);
    // MediaPipe world: x right, y down, z away from camera -> three camera space: x right, y up, z toward viewer
    wlm.forEach((p, i) => this.points[i].set(center.x + p[0], center.y - p[1], center.z - p[2]));

    this.raw = rawCurls(wlm);
    this.curls = normalizedCurls(wlm, this.calibration);
    const g = this.gestures.update(this.curls, t);
    this.grip = g.grip;
    this.openPalm = g.openPalm;
    this.pose = g.pose;
    this.closure = g.closure;
    this.side = f.hand === "Left" ? -1 : 1;
    this.glove.fit(this.points, this.side);
  }

  /** Light the fingertips with the live motor levels (what the glove is doing right now). */
  showMotors(levels: number[]): void {
    this.glove.showMotors(levels);
  }

  update(): void {
    this.group.visible = this.active && !this.hidden;
  }
}
