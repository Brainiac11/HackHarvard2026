// Rover: custom 4-wheel spring-damper model over the terrain (PLAN.md §9.4). Apollo-LRV-like numbers.
// Fixed-step (120 Hz). Produces exactly the signals the haptic mappers need. Mesh: roverMesh.ts; controls: roverControls.ts.
import * as THREE from "three";
import type { Wheel } from "../net/messages";

export const LUNAR_G = 1.62;
export const ROVER = {
  mass: 210, wheelbase: 2.29, track: 1.83, wheelRadius: 0.41,
  k: 4000, c: 410, restLength: 0.35, travel: 0.15, bumpK: 40000,
  aMax: 1.0, bMax: 1.6, vMax: 3.6, boost: 2.2, maxSteerDeg: 25, rollResist: 0.02,
};
const IP = (ROVER.mass * ROVER.wheelbase ** 2) / 12;
const IR = (ROVER.mass * ROVER.track ** 2) / 12;
const ANG_DAMP = 1.5;
const ROUGH_WINDOW_S = 0.3;
const IMPACT_VEL = 1.2;

export type HeightFn = (x: number, z: number) => number;

export interface RoverInput { throttle: number; brake: number; steer: number; boost: boolean }

export class RoverModel {
  x = 0; z = 0; heading = 0; // rad, 0 = north (-z), clockwise
  y = 0; vy = 0; pitch = 0; pitchRate = 0; roll = 0; rollRate = 0;
  v = 0; accel = 0; throttle = 0; steer = 0;
  wheels: Wheel[] = [0, 1, 2, 3].map(() => ({ comp: 0, vel: 0, contact: true }));
  rough = 0;
  private roughHist: { t: number; e: number }[] = [];
  private t = 0;
  private impactCooldown = [0, 0, 0, 0];
  onImpact: (side: "left" | "right", mag: number) => void = () => {};

  // local offsets (forward, right) for FL, FR, RL, RR
  static readonly OFFSETS: [number, number][] = [
    [ROVER.wheelbase / 2, -ROVER.track / 2], [ROVER.wheelbase / 2, ROVER.track / 2],
    [-ROVER.wheelbase / 2, -ROVER.track / 2], [-ROVER.wheelbase / 2, ROVER.track / 2],
  ];

  constructor(private height: HeightFn) {}

  reset(x: number, z: number, heading: number): void {
    Object.assign(this, { x, z, heading, v: 0, vy: 0, pitch: 0, pitchRate: 0, roll: 0, rollRate: 0, accel: 0 });
    const g = this.groundUnder();
    this.y = g + ROVER.wheelRadius + ROVER.restLength - (ROVER.mass * LUNAR_G) / 4 / ROVER.k;
    this.wheels.forEach((w) => Object.assign(w, { comp: 0, vel: 0, contact: true }));
    this.rough = 0;
    this.roughHist = [];
  }

  forward(): [number, number] { return [Math.sin(this.heading), -Math.cos(this.heading)]; }
  right(): [number, number] { return [Math.cos(this.heading), Math.sin(this.heading)]; }

  wheelPos(i: number): [number, number] {
    const [f, r] = RoverModel.OFFSETS[i];
    const [fx, fz] = this.forward(), [rx, rz] = this.right();
    return [this.x + fx * f + rx * r, this.z + fz * f + rz * r];
  }

  private groundUnder(): number {
    let s = 0;
    for (let i = 0; i < 4; i++) s += this.height(...this.wheelPos(i));
    return s / 4;
  }

  step(dt: number, input: RoverInput): void {
    this.t += dt;
    this.throttle = input.throttle;
    this.steer = input.steer;
    const vMax = ROVER.vMax * (input.boost ? ROVER.boost : 1);

    // --- longitudinal: drive force, braking, gravity along the real slope, rolling resistance
    const [fx, fz] = this.forward();
    const L = ROVER.wheelbase;
    const hFront = this.height(this.x + fx * L / 2, this.z + fz * L / 2);
    const hBack = this.height(this.x - fx * L / 2, this.z - fz * L / 2);
    const grade = Math.atan2(hFront - hBack, L);
    let a = input.throttle * ROVER.aMax * (Math.abs(this.v) < vMax ? 1 : 0) - LUNAR_G * Math.sin(grade);
    if (Math.abs(this.v) > 0.01) a -= Math.sign(this.v) * (ROVER.rollResist * LUNAR_G + input.brake * ROVER.bMax);
    else if (input.throttle === 0) a = Math.abs(a) < input.brake * ROVER.bMax + LUNAR_G * 0.15 ? 0 : a; // static friction
    const vPrev = this.v;
    this.v = THREE.MathUtils.clamp(this.v + a * dt, -1.2, vMax);
    if (vPrev > 0 && this.v < 0 && input.throttle >= 0) this.v = 0; // brakes don't reverse
    this.accel = (this.v - vPrev) / dt;

    // --- yaw (kinematic bicycle) and translation
    const delta = THREE.MathUtils.degToRad(ROVER.maxSteerDeg) * input.steer;
    this.heading += (this.v * Math.tan(delta)) / L * dt;
    this.x += fx * this.v * dt;
    this.z += fz * this.v * dt;

    // --- vertical: four spring-dampers driving heave, pitch, roll
    let force = 0, torqueP = 0, torqueR = 0, energy = 0;
    for (let i = 0; i < 4; i++) {
      const [f, r] = RoverModel.OFFSETS[i];
      const [wx, wz] = this.wheelPos(i);
      const ground = this.height(wx, wz) + ROVER.wheelRadius;
      const attach = this.y + Math.sin(this.pitch) * f - Math.sin(this.roll) * r;
      const comp = ROVER.restLength - (attach - ground);
      const w = this.wheels[i];
      const vel = (comp - w.comp) / dt;
      w.comp = comp;
      w.vel = THREE.MathUtils.lerp(w.vel, vel, 0.5);
      w.contact = comp > 0;
      let F = 0;
      if (comp > 0) {
        F = ROVER.k * comp + ROVER.c * vel;
        if (comp > ROVER.travel) F += ROVER.bumpK * (comp - ROVER.travel);
        F = Math.max(0, F);
      }
      force += F;
      torqueP += F * f;
      torqueR -= F * r;
      energy += Math.abs(w.vel);
      this.impactCooldown[i] = Math.max(0, this.impactCooldown[i] - dt);
      if (Math.abs(w.vel) > IMPACT_VEL && this.impactCooldown[i] === 0 && Math.abs(this.v) > 0.3) {
        this.impactCooldown[i] = 0.3;
        this.onImpact(r < 0 ? "left" : "right", Math.min(1, Math.abs(w.vel) / 2.5));
      }
    }
    this.vy += (force / ROVER.mass - LUNAR_G) * dt;
    this.y += this.vy * dt;
    this.pitchRate += (torqueP / IP - ANG_DAMP * this.pitchRate) * dt;
    this.rollRate += (torqueR / IR - ANG_DAMP * this.rollRate) * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.pitchRate * dt, -0.7, 0.7);
    this.roll = THREE.MathUtils.clamp(this.roll + this.rollRate * dt, -0.7, 0.7);

    // safety net: never sink through the ground (e.g. after a teleport)
    const floor = this.groundUnder() + ROVER.wheelRadius + ROVER.restLength - ROVER.travel * 1.5;
    if (this.y < floor) { this.y = floor; this.vy = Math.max(0, this.vy); }

    // --- roughness: RMS of mean |suspension velocity| over a short window, normalised
    this.roughHist.push({ t: this.t, e: energy / 4 });
    while (this.roughHist.length && this.t - this.roughHist[0].t > ROUGH_WINDOW_S) this.roughHist.shift();
    const rms = Math.sqrt(this.roughHist.reduce((s, h) => s + h.e * h.e, 0) / this.roughHist.length);
    this.rough = Math.abs(this.v) < 0.05 ? 0 : THREE.MathUtils.clamp(rms / 0.8, 0, 1);
  }

  headingDeg(): number { return ((THREE.MathUtils.radToDeg(this.heading) % 360) + 360) % 360; }
}
