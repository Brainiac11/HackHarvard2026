// Virtual suit glove driven by the phone tracker (PLAN.md §9.5). Rendered in camera space: the head-mounted
// phone is roughly the astronaut's eye, so the hand appears where they see their real hand.
import * as THREE from "three";
import type { HandFrame } from "../net/messages";
import { CHAINS, DEFAULT_CALIBRATION, GestureState, normalizedCurls, palmRollDeg, rawCurls, TIPS,
  type CurlCalibration } from "./gestures";
import { OneEuroPoints } from "./oneEuro";

const PHONE_HFOV_DEG = 65; // approx. iPhone main camera horizontal FOV at 4:3
const HAND_LENGTH_M = 0.09; // wrist -> middle MCP, used for depth from apparent size
const MIN_DEPTH = 0.28, MAX_DEPTH = 0.65;
const STALE_S = 0.5;

export class TrackedHand {
  readonly group = new THREE.Group();
  readonly palm = new THREE.Object3D(); // pose for holding tools (camera space)
  private joints: THREE.InstancedMesh;
  private bones: THREE.InstancedMesh;
  private filter = new OneEuroPoints(1.2, 0.02);
  private gestures = new GestureState();
  private lastFrame = -1e9;
  private lastDepth = 0.45;
  private depthVel = 0;
  private points: THREE.Vector3[] = Array.from({ length: 21 }, () => new THREE.Vector3());
  calibration: CurlCalibration = structuredClone(DEFAULT_CALIBRATION);
  curls = [0, 0, 0, 0, 0];
  raw = [0, 0, 0, 0, 0];
  grip = false;
  trigger = 0;
  openPalm = false;
  steer = 0;
  push = 0; // hand moving forward (m/s, positive = away from the eye)
  fps = 0;

  constructor(private camera: THREE.PerspectiveCamera) {
    const glove = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.7 });
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0085, 12, 8), glove.clone(), 21);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0075, 0.0075, 1, 8), glove, 20);
    for (let i = 0; i < 21; i++) this.joints.setColorAt(i, new THREE.Color(0xf2efe8));
    this.group.add(this.joints, this.bones, this.palm);
    this.group.visible = false;
    this.joints.frustumCulled = this.bones.frustumCulled = false;
    camera.add(this.group);
  }

  get active(): boolean { return performance.now() / 1000 - this.lastFrame < STALE_S; }

  onFrame(f: HandFrame): void {
    if (f.lm.length !== 21 || f.wlm.length !== 21) return;
    const t = performance.now() / 1000;
    this.lastFrame = t;
    this.fps = f.fps;
    const wlm = this.filter.filter(f.wlm, t);

    // depth from apparent hand size (image) vs metric size (world landmarks)
    const imgSize = Math.hypot(f.lm[9][0] - f.lm[0][0], f.lm[9][1] - f.lm[0][1]);
    const tanH = Math.tan(THREE.MathUtils.degToRad(PHONE_HFOV_DEG / 2));
    const depth = THREE.MathUtils.clamp(HAND_LENGTH_M / Math.max(1e-3, imgSize * 2 * tanH), MIN_DEPTH, MAX_DEPTH);
    this.depthVel = THREE.MathUtils.lerp(this.depthVel, (depth - this.lastDepth) * 30, 0.3);
    this.lastDepth = THREE.MathUtils.lerp(this.lastDepth, depth, 0.35);
    this.push = Math.max(0, this.depthVel);

    // hand centre in the sim camera's frustum at that depth
    const cu = f.lm.reduce((s, p) => s + p[0], 0) / 21, cv = f.lm.reduce((s, p) => s + p[1], 0) / 21;
    const vTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const center = new THREE.Vector3((cu - 0.5) * 2 * this.lastDepth * vTan * this.camera.aspect,
      -(cv - 0.5) * 2 * this.lastDepth * vTan, -this.lastDepth);
    // MediaPipe world: x right, y down, z away from camera -> three camera space: x right, y up, z toward viewer
    wlm.forEach((p, i) => this.points[i].set(center.x + p[0], center.y - p[1], center.z - p[2]));

    this.raw = rawCurls(wlm);
    this.curls = normalizedCurls(wlm, this.calibration);
    const g = this.gestures.update(this.curls, t);
    this.grip = g.grip;
    this.trigger = g.trigger;
    this.openPalm = g.openPalm;
    this.steer = THREE.MathUtils.clamp(palmRollDeg(wlm, f.hand) / 40, -1, 1);
    this.pose();
  }

  private pose(): void {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    this.points.forEach((p, i) => this.joints.setMatrixAt(i, m.compose(p, q.identity(), s.set(1, 1, 1))));
    let b = 0;
    for (const chain of CHAINS) {
      for (let i = 0; i < chain.length - 1; i++) {
        const a = this.points[chain[i]], c = this.points[chain[i + 1]];
        const dir = new THREE.Vector3().subVectors(c, a);
        const len = dir.length();
        q.setFromUnitVectors(up, dir.normalize());
        this.bones.setMatrixAt(b++, m.compose(a.clone().lerp(c, 0.5), q, s.set(1, len, 1)));
      }
    }
    this.joints.instanceMatrix.needsUpdate = this.bones.instanceMatrix.needsUpdate = true;

    // palm frame for holding tools: origin between wrist and middle MCP, forward along the fingers
    const wrist = this.points[0], mid = this.points[9], idx = this.points[5], pinky = this.points[17];
    const forward = new THREE.Vector3().subVectors(mid, wrist).normalize();
    const across = new THREE.Vector3().subVectors(pinky, idx).normalize();
    const normal = new THREE.Vector3().crossVectors(across, forward).normalize();
    const back = forward.clone().negate();
    const lateral = new THREE.Vector3().crossVectors(normal, back).normalize();
    const basis = new THREE.Matrix4().makeBasis(lateral, normal, back);
    this.palm.position.copy(wrist).lerp(mid, 0.6);
    this.palm.quaternion.setFromRotationMatrix(basis);
  }

  /** Light the fingertips with the live motor levels (what the glove is doing right now). */
  showMotors(levels: number[]): void {
    const base = new THREE.Color(0xf2efe8), hot = new THREE.Color(0xffa133);
    TIPS.forEach((tip, i) => this.joints.setColorAt(tip, base.clone().lerp(hot, Math.min(1, levels[i] * 1.4))));
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;
  }

  update(): void {
    this.group.visible = this.active;
  }
}
