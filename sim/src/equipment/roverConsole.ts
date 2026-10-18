// The rover's control & display console face, after the Apollo LRV's: heading, attitude and speed instruments, the
// navigation readouts (bearing, distance driven, range back to the start: the LRV's "to the LM"), battery and
// caution lamps. Painted on a canvas and repainted at most REFRESH_HZ, not every frame: an upload per frame is waste.
import * as THREE from "three";
import { canvasTexture } from "../gfx/procedural";
import type { RoverModel } from "./rover";

const W = 512, H = 320;
const DIAL_Y = 88, DIAL_R = 58; // the three instruments across the top, captions clear of the readouts below
const REFRESH_S = 0.1;
const SPEED_MAX_KMH = 20;
const BATTERY_AH = 121; // each of the LRV's two silver-zinc batteries
const AH_PER_KM = 3.2;
const CAUTION_DEG = 15;
const INK = "#e9e6dc", DIM = "#8d9196", AMBER = "#ffb347", RED = "#ff5a4a", GREEN = "#7dff9a";
const FONT = "system-ui, 'Segoe UI', sans-serif";

export class RoverConsole {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  private since = REFRESH_S;
  private odometer = 0; // m
  private home: [number, number] | null = null;

  constructor() {
    this.texture = canvasTexture(W, H, () => {});
    this.g = (this.texture.image as HTMLCanvasElement).getContext("2d")!;
  }

  update(dt: number, m: RoverModel): void {
    this.home ??= [m.x, m.z];
    this.odometer += Math.abs(m.v) * dt;
    this.since += dt;
    if (this.since < REFRESH_S) return;
    this.since = 0;
    this.paint(m);
    this.texture.needsUpdate = true;
  }

  private paint(m: RoverModel): void {
    const g = this.g;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#34383c");
    grad.addColorStop(1, "#24272a");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "#5c6166";
    g.lineWidth = 3;
    g.strokeRect(4, 4, W - 8, H - 8);
    for (const [x, y] of [[14, 14], [W - 14, 14], [14, H - 14], [W - 14, H - 14]]) this.screw(x, y);

    const heading = m.headingDeg(), pitch = THREE.MathUtils.radToDeg(m.pitch), roll = THREE.MathUtils.radToDeg(m.roll);
    const kmh = Math.abs(m.v) * 3.6;
    this.headingDial(92, DIAL_Y, heading);
    this.attitude(256, DIAL_Y, pitch, roll);
    this.speedDial(420, DIAL_Y, kmh);

    const [hx, hz] = this.home!;
    const dx = hx - m.x, dz = hz - m.z;
    const bearing = ((THREE.MathUtils.radToDeg(Math.atan2(dx, -dz)) % 360) + 360) % 360; // clockwise from north (-z)
    this.readout(24, 186, "BEARING", `${bearing.toFixed(0).padStart(3, "0")}°`);
    this.readout(142, 186, "DISTANCE", `${(this.odometer / 1000).toFixed(2)} km`);
    this.readout(260, 186, "RANGE", `${(Math.hypot(dx, dz) / 1000).toFixed(2)} km`);
    this.readout(378, 186, "HEADING", `${heading.toFixed(0).padStart(3, "0")}°`);

    const ah = Math.max(0, BATTERY_AH - (this.odometer / 1000) * AH_PER_KM);
    this.bar(24, 252, "BATT 1  A·h", ah / BATTERY_AH, ah.toFixed(0));
    this.bar(24, 284, "BATT 2  A·h", (ah - 1.5) / BATTERY_AH, (ah - 1.5).toFixed(0));
    const switches = ["DRIVE", "STEER F", "STEER R", "NAV", "LCRU", "TV"];
    switches.forEach((label, i) => this.toggle(222 + i * 40, 270, label));
    const tilt = Math.abs(pitch) > CAUTION_DEG || Math.abs(roll) > CAUTION_DEG;
    this.lamp(480, 256, "TILT", tilt ? RED : "#3a2422");
    this.lamp(480, 290, "PWR", GREEN);
  }

  private screw(x: number, y: number): void {
    const g = this.g;
    g.fillStyle = "#6b7075";
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#2a2d30";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x - 3.5, y - 1);
    g.lineTo(x + 3.5, y + 1);
    g.stroke();
  }

  /** Bezel + black face, and the instrument's name under it. */
  private bezel(x: number, y: number, r: number, label: string): void {
    const g = this.g;
    g.fillStyle = "#151719";
    g.beginPath();
    g.arc(x, y, r + 7, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#71767c";
    g.lineWidth = 2;
    g.stroke();
    g.fillStyle = "#08090a";
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    this.text(label, x, y + r + 21, 11, DIM, "center");
  }

  private text(s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left",
               weight = 600): void {
    const g = this.g;
    g.font = `${weight} ${size}px ${FONT}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  }

  /** Compass card turning under a fixed lubber line. */
  private headingDial(x: number, y: number, heading: number): void {
    const g = this.g, r = DIAL_R;
    this.bezel(x, y, r, "HEADING");
    g.save();
    g.translate(x, y);
    g.rotate(THREE.MathUtils.degToRad(-heading));
    g.strokeStyle = INK;
    for (let d = 0; d < 360; d += 10) {
      const a = THREE.MathUtils.degToRad(d), long = d % 30 === 0;
      g.lineWidth = long ? 2 : 1;
      g.beginPath();
      g.moveTo(Math.sin(a) * r * 0.97, -Math.cos(a) * r * 0.97);
      g.lineTo(Math.sin(a) * r * (long ? 0.8 : 0.87), -Math.cos(a) * r * (long ? 0.8 : 0.87));
      g.stroke();
      if (!long) continue;
      g.save();
      g.rotate(a);
      const label = ({ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>)[d] ?? String(d / 10);
      this.text(label, 0, -r * 0.6, label.length === 1 && d % 90 === 0 ? 15 : 11, d === 0 ? AMBER : INK, "center", 700);
      g.restore();
    }
    g.restore();
    g.fillStyle = AMBER;
    g.beginPath();
    g.moveTo(x, y - r + 2);
    g.lineTo(x - 6, y - r - 7);
    g.lineTo(x + 6, y - r - 7);
    g.fill();
  }

  /** Artificial horizon: the ground tilts with roll and drops as the nose pitches up. */
  private attitude(x: number, y: number, pitch: number, roll: number): void {
    const g = this.g, r = DIAL_R, k = 2.4; // px per degree of pitch
    this.bezel(x, y, r, "PITCH · ROLL");
    g.save();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    g.translate(x, y);
    g.rotate(THREE.MathUtils.degToRad(roll));
    g.fillStyle = "#1d2a3c";
    g.fillRect(-r * 2, -r * 2, r * 4, r * 2 + pitch * k);
    g.fillStyle = "#5a4a38";
    g.fillRect(-r * 2, pitch * k, r * 4, r * 2);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-r, pitch * k);
    g.lineTo(r, pitch * k);
    g.stroke();
    g.lineWidth = 1;
    for (const p of [-20, -10, 10, 20]) {
      const yy = (pitch - p) * k, half = Math.abs(p) === 10 ? 14 : 22;
      g.beginPath();
      g.moveTo(-half, yy);
      g.lineTo(half, yy);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = AMBER;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x - 30, y);
    g.lineTo(x - 10, y);
    g.lineTo(x - 5, y + 6);
    g.moveTo(x + 30, y);
    g.lineTo(x + 10, y);
    g.lineTo(x + 5, y + 6);
    g.stroke();
    this.text(`${pitch >= 0 ? "+" : ""}${pitch.toFixed(0)}° ${roll >= 0 ? "R" : "L"}${Math.abs(roll).toFixed(0)}°`,
      x, y + r - 10, 11, Math.abs(pitch) > CAUTION_DEG || Math.abs(roll) > CAUTION_DEG ? RED : INK, "center");
  }

  private speedDial(x: number, y: number, kmh: number): void {
    const g = this.g, r = DIAL_R;
    this.bezel(x, y, r, "SPEED km/h");
    const angle = (v: number) => THREE.MathUtils.degToRad(-225 + (Math.min(v, SPEED_MAX_KMH) / SPEED_MAX_KMH) * 270);
    g.strokeStyle = INK;
    for (let v = 0; v <= SPEED_MAX_KMH; v++) {
      const a = angle(v), major = v % 5 === 0;
      g.lineWidth = major ? 2 : 1;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 0.96, y + Math.sin(a) * r * 0.96);
      g.lineTo(x + Math.cos(a) * r * (major ? 0.78 : 0.86), y + Math.sin(a) * r * (major ? 0.78 : 0.86));
      g.stroke();
      if (major) this.text(String(v), x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6 + 5, 13, INK, "center");
    }
    const a = angle(kmh);
    g.strokeStyle = AMBER;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x - Math.cos(a) * 10, y - Math.sin(a) * 10);
    g.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9);
    g.stroke();
    g.fillStyle = "#3a3e42";
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    this.text(kmh.toFixed(1), x, y + r - 12, 15, AMBER, "center", 700);
  }

  private readout(x: number, y: number, label: string, value: string): void {
    const g = this.g;
    this.text(label, x + 2, y, 10, DIM);
    g.fillStyle = "#0b0c0d";
    g.fillRect(x, y + 5, 108, 30);
    g.strokeStyle = "#4b5055";
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 5.5, 107, 29);
    g.font = `700 20px ui-monospace, 'DejaVu Sans Mono', monospace`;
    g.fillStyle = AMBER;
    g.textAlign = "right";
    g.fillText(value, x + 100, y + 28);
  }

  private bar(x: number, y: number, label: string, frac: number, value: string): void {
    const g = this.g;
    this.text(label, x, y, 10, DIM);
    g.fillStyle = "#0b0c0d";
    g.fillRect(x, y + 4, 150, 12);
    g.fillStyle = frac > 0.25 ? GREEN : AMBER;
    g.fillRect(x + 1, y + 5, Math.max(0, 148 * frac), 10);
    this.text(value, x + 186, y + 15, 13, INK, "right", 700);
  }

  private toggle(x: number, y: number, label: string): void {
    const g = this.g;
    g.fillStyle = "#121315";
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#b9bcc0";
    g.lineWidth = 4;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - 14);
    g.stroke();
    g.lineCap = "butt";
    this.text(label, x, y + 24, 8, DIM, "center");
  }

  private lamp(x: number, y: number, label: string, color: string): void {
    const g = this.g;
    g.fillStyle = color;
    g.fillRect(x - 18, y - 12, 36, 18);
    g.strokeStyle = "#0b0c0d";
    g.lineWidth = 2;
    g.strokeRect(x - 18, y - 12, 36, 18);
    this.text(label, x, y + 2, 10, "#111", "center", 800);
  }
}
