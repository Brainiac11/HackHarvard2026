// Drill press at the work site (PLAN.md §9.3): the machine model (drillPressModel.ts) driven by the press logic
// (drillPress.ts), plus what makes the cutting visible: the bores, cuttings and sparks, and the control panel.
import * as THREE from "three";
import { pressMaterials } from "./drillMaterials";
import { DrillPress, PRESS, type DrillTelemetry, type Sample } from "./drillPress";
import { BIT_R, buildPress, type PressModel } from "./drillPressModel";

const SPIN_RAD_S = 30; // drawn spindle speed: the real 450 rpm would strobe at 60 fps
const RPM_MAX = 450;
const PINION_R = 0.05; // feed handle: quill travel per radian of handle turn
const HANDWHEEL_TURNS = 3; // cross-slide handwheel turns per sample slot
const LCD_HZ = 8;
const STATION_Z = 0.85; // the operator stands this far in front of the spindle
const LUNAR_G = 1.62;

/** A fixed pool of ballistic particles (lunar gravity, no air), recycled round-robin. */
class Particles {
  readonly points: THREE.Points;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private live = 0;

  constructor(n: number, material: THREE.PointsMaterial) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3).fill(-9999), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("color", this.col);
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, c: THREE.Color): void {
    const i = this.next;
    this.next = (i + 1) % this.life.length;
    this.pos.setXYZ(i, x, y, z);
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col.setXYZ(i, c.r, c.g, c.b);
    this.life[i] = life;
    this.live = this.life.length;
    this.col.needsUpdate = true;
  }

  /** Advance; a particle dies when its time is up or it falls below `floor`. */
  update(dt: number, floor: number): void {
    if (!this.live) return; // all dead and parked: nothing to upload
    let live = 0;
    for (let i = 0; i < this.life.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= LUNAR_G * dt;
      const y = this.pos.getY(i) + this.vel[i * 3 + 1] * dt;
      if (this.life[i] <= 0 || y < floor) {
        this.life[i] = 0;
        this.pos.setXYZ(i, 0, -9999, 0);
        continue;
      }
      this.pos.setXYZ(i, this.pos.getX(i) + this.vel[i * 3] * dt, y, this.pos.getZ(i) + this.vel[i * 3 + 2] * dt);
      live++;
    }
    this.live = live;
    this.pos.needsUpdate = true;
  }
}

/** What the control panel shows: state, sample, bore depth, spindle speed and load (0..1). */
export interface DrillReadout {
  state: string; label: string | null; kind: "soft" | "hard" | null; depthMm: number | null; rpm: number; load: number;
  stalled: boolean;
}

const _c = new THREE.Color();
const SPARK = new THREE.Color(1, 0.55, 0.15); // additive: where sparks overlap they burn white-hot

export class DrillSystem {
  readonly press = new DrillPress();
  readonly position: THREE.Vector3; // on the ground under the spindle
  readonly station = new THREE.Vector3(); // where the operator stands (ground level)
  readonly focus = new THREE.Vector3(); // what the operator looks at: the bit over the samples
  operating = false; // someone is at the controls
  feed = 0; // the operator's command: 1 lower, 0 hold, -1 raise
  shake = 0;
  onBreakthrough: () => void = () => {};
  private model: PressModel;
  private dust: Particles;
  private sparks: Particles;
  private emitCarry = 0;
  private lcd: CanvasRenderingContext2D;
  private lcdAt = -1;
  private lcdText = "";
  private clock = 0;

  constructor(scene: THREE.Scene, site: THREE.Vector3, ground: (x: number, z: number) => number) {
    this.model = buildPress(pressMaterials(), this.press.samples);
    const x = site.x + 1, z = site.z - 1.6; // facing the walker spawn (site + (1, 3), looking north)
    this.position = new THREE.Vector3(x, ground(x, z), z);
    this.model.root.position.copy(this.position);
    scene.add(this.model.root);
    this.station.set(x, this.position.y, z + STATION_Z);
    this.focus.set(x, this.position.y + PRESS.homeTipY - 0.07, z);
    this.lcd = (this.model.lcd.image as HTMLCanvasElement).getContext("2d")!;
    this.press.onBreakthrough = () => this.onBreakthrough();

    this.dust = new Particles(500, new THREE.PointsMaterial({ size: 0.005, vertexColors: true }));
    this.sparks = new Particles(200, new THREE.PointsMaterial({ size: 0.004, vertexColors: true, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    scene.add(this.dust.points, this.sparks.points);
    this.update(0);
  }

  /** Seat the machine on the ground again: F swaps the synthetic detail in or out under it. */
  reground(ground: (x: number, z: number) => number): void {
    const dy = ground(this.position.x, this.position.z) - this.position.y;
    for (const p of [this.position, this.station, this.focus, this.model.root.position]) p.y += dy;
  }

  /** The sample under the bit (null while the table moves). */
  get sample(): Sample | null { return this.press.under; }

  /** Slide the table toward the next sample (-1 left, +1 right); false while the bit is down among the samples. */
  slideTable(dir: -1 | 1): boolean { return this.press.slideTable(dir); }

  /** Fresh samples; false while the bit is down among them. */
  resetSamples(): boolean { return this.press.reset(); }

  update(dt: number): void {
    this.clock += dt;
    // nobody at the controls: the quill's return spring takes it home and the spindle stops
    this.press.step(dt, this.operating ? this.feed : -1);
    const p = this.press, m = this.model;

    m.quill.position.y = -p.travel;
    m.spindle.rotation.y = (m.spindle.rotation.y + p.motor * SPIN_RAD_S * dt) % (Math.PI * 2);
    m.handle.rotation.x = p.travel / PINION_R;
    m.carriage.position.x = -(p.table - (p.samples.length - 1) / 2) * PRESS.slotPitch;
    m.handwheel.rotation.x = p.table * HANDWHEEL_TURNS * Math.PI * 2;
    p.samples.forEach((s, i) => {
      const v = m.samples[i];
      v.bore.scale.y = Math.max(1e-4, s.depth);
      v.boreMat.color.setScalar(1 - 0.75 * Math.min(1, s.depth / 0.05)); // sunlight doesn't reach far down the hole
      v.rim.visible = s.depth > 0.002;
      const heap = 0.4 + 0.6 * Math.min(1, s.depth / 0.04);
      v.rim.scale.set(0.5 + 0.5 * heap, heap, 0.5 + 0.5 * heap);
    });

    m.lamps.power.emissiveIntensity = 2.2;
    m.lamps.spindle.emissiveIntensity = p.motor > 0.02 ? 2.5 : 0;
    m.lamps.stall.emissiveIntensity = p.stalled && this.clock % 0.5 < 0.25 ? 3 : 0;

    const s = p.under;
    if (p.contact && s) this.emit(dt, s);
    else this.emitCarry = 0;
    const floor = this.position.y + PRESS.baseY - 0.03;
    this.dust.update(dt, floor);
    this.sparks.update(dt, floor);
    this.shake = p.contact && s ? p.motor * (s.hardness > 0.5 ? 0.004 : 0.001) : 0;

    if (this.clock - this.lcdAt >= 1 / LCD_HZ) {
      this.lcdAt = this.clock;
      this.drawLcd();
    }
  }

  /** Cuttings thrown out of the bore (more while cutting), and sparks off hard rock while the bit is pushed. */
  private emit(dt: number, s: Sample): void {
    const p = this.press, hard = s.kind === "hard", cutting = p.feed > 0;
    this.emitCarry += (hard ? 60 : cutting ? 260 : 40) * p.motor * dt;
    const view = this.model.samples[p.samples.indexOf(s)];
    const x = this.position.x, y = this.position.y + p.top(s) + 0.002, z = this.position.z;
    for (; this.emitCarry >= 1; this.emitCarry--) {
      const a = Math.random() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const out = 0.05 + Math.random() * (hard ? 0.12 : 0.2);
      _c.copy(view.dust).multiplyScalar(0.8 + 0.4 * Math.random());
      this.dust.emit(x + ca * BIT_R, y, z + sa * BIT_R, ca * out, 0.1 + Math.random() * 0.3, sa * out,
        0.4 + Math.random() * 0.6, _c);
      if (!hard || !cutting) continue;
      for (let k = 0; k < 2; k++) {
        const b = Math.random() * Math.PI * 2, fast = 0.5 + Math.random();
        this.sparks.emit(x + Math.cos(b) * BIT_R, y, z + Math.sin(b) * BIT_R, Math.cos(b) * fast,
          0.1 + Math.random() * 0.6, Math.sin(b) * fast, 0.1 + Math.random() * 0.2, SPARK);
      }
    }
  }

  /** The control panel's readings (the LCD's, and the HUD's: the LCD is a few pixels tall on screen). */
  readout(): DrillReadout {
    const p = this.press, s = p.under;
    const load = p.stalled ? 1 : p.contact && s ? (p.rate > 0 ? 0.2 + 0.75 * s.hardness : 0.1) : 0.04 * p.motor;
    const state = !this.operating ? "STANDBY" : p.stalled ? "STALL" : s?.through ? "THROUGH" : p.contact
      ? (p.rate > 0 ? "CUTTING" : "DWELL") : p.motor > 0.02 ? "FREE SPIN" : "READY";
    return { state, label: s?.label ?? null, kind: s?.kind ?? null, depthMm: s ? s.depth * 1000 : null,
      rpm: Math.round(RPM_MAX * p.motor * (1 - 0.3 * load)), load, stalled: p.stalled };
  }

  /** The control panel LCD: which sample, how deep the bore is, spindle speed and load. Repainted only on change. */
  private drawLcd(): void {
    const { state, label, kind, depthMm, rpm, load, stalled } = this.readout();
    const depth = depthMm === null ? "--.-" : depthMm.toFixed(1);
    const text = `${state}|${label}|${depth}|${rpm}|${load.toFixed(2)}`;
    if (text === this.lcdText) return;
    this.lcdText = text;

    const g = this.lcd, W = g.canvas.width;
    const amber = "#ffb547", dim = "#5a3e17", alert = stalled ? "#ff4a3a" : amber;
    g.fillStyle = "#0b0904";
    g.fillRect(0, 0, W, g.canvas.height);
    g.font = "bold 20px ui-monospace, monospace";
    g.fillStyle = alert;
    g.fillText(state, 12, 26);
    g.fillStyle = dim;
    g.textAlign = "right";
    g.fillText(kind ? kind.toUpperCase() : "", W - 12, 26);
    g.textAlign = "left";
    g.fillStyle = amber;
    g.font = "16px ui-monospace, monospace";
    g.fillText((label ?? "table moving").toUpperCase(), 12, 50);
    g.font = "bold 30px ui-monospace, monospace";
    g.fillText(`${depth.padStart(5)} mm`, 12, 88);
    g.font = "18px ui-monospace, monospace";
    g.fillText(`${String(rpm).padStart(3)} RPM`, 12, 116);
    g.fillText(`LOAD ${String(Math.round(load * 100)).padStart(3)}%`, 130, 116);
    g.fillStyle = dim;
    g.fillRect(12, 130, W - 24, 16);
    g.fillStyle = alert;
    g.fillRect(12, 130, (W - 24) * load, 16);
    this.model.lcd.needsUpdate = true;
  }

  telemetry(): DrillTelemetry { return this.press.telemetry(this.operating); }
}
