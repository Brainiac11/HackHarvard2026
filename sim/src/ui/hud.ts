// DOM heads-up display (PLAN.md §9.7). Pure view: main.ts feeds it hub messages and sim state.
import type { AssistantAdvice, HubAssistant, HubState, HubToast, HubWelcome } from "../net/messages";

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const FEELING_ICON: Record<string, string> = {
  drill_free_spin: "〰", soft_material_hum: "≈", hard_material_grinding: "⩩", drill_stall_warning: "⚠",
  drill_breakthrough: "◎", rover_speed_rumble: "≋", rough_terrain_left: "◧", rough_terrain_right: "◨",
  rough_terrain_both: "▦", wheel_impact: "✸", slope_warning: "⚠", auth_confirmation: "✓", setting_change: "⇅",
  access_denied: "⛔", none: "·",
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export interface ProvenanceInfo {
  site: string; lat: number; lon: number; elev: number; slope: number; err: number; cover: number;
  detail: boolean; overviewUv: number[]; posUv: [number, number]; limit: number | null;
}

export class Hud {
  private root = el("div", "hud", document.body);
  private card = el("div", "panel card", this.root);
  private status = el("div", "panel status", this.root);
  private motors = el("div", "panel motors", this.root);
  private bars: HTMLDivElement[] = [];
  private dominant: HTMLDivElement;
  private prov = el("div", "panel provenance", this.root);
  private assistant = el("div", "panel assistant hidden", this.root);
  private prompt = el("div", "prompt hidden", this.root);
  private toasts = el("div", "toasts", this.root);
  private splash = el("div", "splash hidden", this.root);
  private help = el("div", "panel help hidden", this.root);
  private crosshair = el("div", "crosshair", this.root);
  private minimapDot: HTMLDivElement;
  private provText: HTMLDivElement;
  private speedo = el("div", "panel speedo hidden", this.root);
  private voice = el("div", "panel voice", this.root);
  private voiceStatus: HTMLDivElement;
  private voiceLog: HTMLDivElement;
  readonly voiceInput: HTMLInputElement;

  constructor(overviewUrl: string) {
    this.card.innerHTML = `<div class="who">No astronaut identified</div><div class="sub">Tap your glove on the reader (or press N)</div>`;
    const bars = el("div", "bars", this.motors);
    FINGERS.forEach((f) => {
      const col = el("div", "barcol", bars);
      const track = el("div", "track", col);
      this.bars.push(el("div", "fill", track));
      el("div", "lbl", col, f[0]);
    });
    this.dominant = el("div", "dominant", this.motors, "glove idle");
    const mini = el("div", "minimap", this.prov);
    mini.style.backgroundImage = `url(${overviewUrl})`;
    const box = el("div", "box", mini);
    box.dataset.role = "box";
    this.minimapDot = el("div", "dot", box);
    this.provText = el("div", "provtext", this.prov);
    this.voiceStatus = el("div", "vstatus", this.voice, "CAPCOM · offline (hold V to talk)");
    this.voiceLog = el("div", "vlog", this.voice);
    this.voiceInput = el("input", "vinput hidden", this.voice) as HTMLInputElement;
    this.voiceInput.placeholder = "Type to CAPCOM, Enter to send, Esc to cancel";
    this.help.innerHTML = `<h3>Controls</h3>
      <div><b>WASD</b> move / drive · <b>Mouse</b> look (click to capture) · <b>Shift</b> run / boost</div>
      <div><b>E</b> pick up drill · enter/exit rover · <b>Space</b>/<b>RMB</b> drill trigger</div>
      <div>Drill aim: put the reticle on a sample (tracked hand: just above your fist) · green = in reach, amber = step closer</div>
      <div><b>N</b> simulate glove tap, or enroll an unknown tag (Shift+N: crewmate) · <b>H</b> ask Mission Assistant · <b>J</b> auto-coach on/off</div>
      <div><b>F</b> synthetic detail on/off · <b>C</b> rover camera · <b>R</b> reset rover · <b>Q</b> reset samples</div>
      <div><b>V</b> hold to talk to CAPCOM · <b>T</b> type a command · <b>G</b> CAPCOM reads assistant alerts</div>
      <div><b>K</b> calibrate hand (open, then fist) · <b>?</b> this help</div>`;
  }

  toggleHelp(): void { this.help.classList.toggle("hidden"); }

  setVoiceStatus(status: string, detail = ""): void {
    this.voiceStatus.className = `vstatus ${status}`;
    this.voiceStatus.textContent = `CAPCOM · ${status}${detail ? ` (${detail})` : ""}`;
  }

  addTranscript(role: string, text: string): void {
    if (!text.trim()) return;
    const line = el("div", `vline v-${role}`, this.voiceLog); // prefixed: ".assistant" is the Mission Assistant panel
    line.innerHTML = `<b>${role === "user" ? "You" : role === "assistant" ? "CAPCOM" : "·"}</b> ${esc(text)}`;
    while (this.voiceLog.children.length > 6) this.voiceLog.firstChild!.remove();
    this.voiceLog.scrollTop = this.voiceLog.scrollHeight; // the box clips: keep the newest line in view
  }

  setHubConnected(ok: boolean): void { this.root.classList.toggle("offline", !ok); }

  updateState(s: HubState): void {
    const p = s.profile;
    const nameOf = (id: string) => esc(s.profiles.find((x) => x.id === id)?.name ?? id);
    const unknown = s.nfc.unknown_uid
      ? `<div class="sub enroll">Unknown glove ${esc(s.nfc.unknown_uid.slice(0, 8))}… · <b>N</b> enroll to ${nameOf("rivera")} · <b>Shift+N</b> ${nameOf("okafor")}</div>`
      : "";
    if (p) {
      const img = p.patch_url ? `<img class="patch" src="${esc(p.patch_url)}" alt="">` : "";
      const auth = s.equipment.authorized.length ? s.equipment.authorized.join(", ") : "none";
      this.card.innerHTML = `${img}<div class="ring">${esc(p.callsign)}</div>
        <div class="who">${esc(p.name)}</div>
        <div class="sub">Active: <b>${s.equipment.active ?? "—"}</b> · authorized: ${auth}</div>
        <div class="sub small">drill ×${p.settings.drill.sensitivity} · terrain ×${p.settings.rover.terrain_sensitivity} · rumble ×${p.settings.rover.vibration} · slope warn ${p.settings.rover.slope_warn_deg}°</div>${unknown}`;
    } else {
      this.card.innerHTML = `<div class="who">No astronaut identified</div><div class="sub">Tap your glove on the reader (or press N)</div>${unknown}`;
    }
    const light = (ok: boolean, label: string, detail = "") =>
      `<div class="light ${ok ? "on" : "off"}"><i></i>${label}${detail ? `<span>${detail}</span>` : ""}</div>`;
    this.status.innerHTML = [
      light(true, "Hub"),
      light(s.glove.connected, `Glove ${s.glove.transport}`, s.glove.rtt_ms != null ? `${s.glove.rtt_ms} ms` : ""),
      light(s.nfc.backend === "pcsc" || s.nfc.backend === "hid" || s.nfc.backend === "serial", "NFC", s.nfc.backend),
      light(s.tracker.connected, "Tracker", s.tracker.connected
        ? `${s.tracker.fps} fps${s.tracker.engine === "anyhand" ? " · AnyHand" : ""}` : ""),
      light(s.voice.configured, "Grok"),
      light(!s.assistant.last_error, "Assistant", `${s.assistant.backend}${s.assistant.auto ? " · auto" : ""}`),
    ].join("");
  }

  updateMotors(levels: number[], dominant: string | null, alert: boolean): void {
    levels.forEach((v, i) => {
      this.bars[i].style.height = `${Math.round(v * 100)}%`;
      this.bars[i].classList.toggle("alert", alert);
    });
    this.dominant.textContent = dominant ? dominant.replace(".", " · ").replace(/_/g, " ") : "glove idle";
  }

  updateProvenance(p: ProvenanceInfo): void {
    const box = this.prov.querySelector<HTMLDivElement>("[data-role=box]")!;
    const [u0, v0, u1, v1] = p.overviewUv;
    Object.assign(box.style, { left: `${u0 * 100}%`, top: `${v0 * 100}%`, width: `${(u1 - u0) * 100}%`, height: `${(v1 - v0) * 100}%` });
    Object.assign(this.minimapDot.style, { left: `${p.posUv[0] * 100}%`, top: `${p.posUv[1] * 100}%` });
    const over = p.limit != null && p.slope > p.limit;
    this.provText.innerHTML = `<div class="src">NASA LOLA 5 m/px · ${p.site}</div>
      <div>${p.lat.toFixed(4)}°, ${p.lon.toFixed(3)}°E · elev ${p.elev.toFixed(0)} m</div>
      <div class="${over ? "warn" : ""}">LOLA slope <b>${p.slope.toFixed(1)}° ± ${p.err.toFixed(1)}°</b>${p.limit != null ? ` (limit ${p.limit}°)` : ""}</div>
      <div class="small">${p.cover > 0 ? `${p.cover} laser return${p.cover > 1 ? "s" : ""} in this cell (measured)` : "no laser return here (interpolated)"}</div>
      <div class="small">Synthetic fine detail: <b>${p.detail ? "ON" : "OFF"}</b> [F] · Barker et al. 2021</div>`;
  }

  setSpeedo(visible: boolean, kmh = 0, rough = 0, pitch = 0, roll = 0): void {
    this.speedo.classList.toggle("hidden", !visible);
    if (visible) this.speedo.innerHTML = `<b>${kmh.toFixed(1)}</b> km/h<div class="small">rough ${(rough * 100).toFixed(0)}% · pitch ${pitch.toFixed(0)}° · roll ${roll.toFixed(0)}°</div>`;
  }

  setPrompt(text: string | null): void {
    this.prompt.classList.toggle("hidden", !text);
    if (text) this.prompt.textContent = text;
  }

  /** x, y: screen position as 0..1 fractions (the drill reticle moves). state: on a sample in reach / out of reach. */
  setCrosshair(visible: boolean, x = 0.5, y = 0.5, state: "" | "lock" | "far" = ""): void {
    this.crosshair.classList.toggle("hidden", !visible);
    this.crosshair.classList.toggle("lock", state === "lock");
    this.crosshair.classList.toggle("far", state === "far");
    this.crosshair.style.left = `${x * 100}%`;
    this.crosshair.style.top = `${y * 100}%`;
  }

  toast(t: HubToast | { level: string; text: string }): void {
    const div = el("div", `toast ${t.level}`, this.toasts, t.text);
    setTimeout(() => div.classList.add("fade"), 3500);
    setTimeout(() => div.remove(), 4200);
  }

  welcome(w: HubWelcome): void {
    this.splash.innerHTML = `<img src="${esc(w.patch_url)}" alt=""><div class="ring">${esc(w.callsign)}</div><div class="name">Welcome, ${esc(w.name)}</div>`;
    this.splash.classList.remove("hidden");
    setTimeout(() => this.splash.classList.add("hidden"), 1800);
  }

  assistantUpdate(a: HubAssistant): void {
    this.assistant.classList.remove("hidden");
    if (a.status === "thinking") {
      this.assistant.classList.add("thinking");
      if (!this.assistant.innerHTML) this.assistant.innerHTML = `<div class="head">Mission Assistant</div>`;
      this.assistant.querySelector(".head")!.textContent = "Mission Assistant · analyzing…";
      return;
    }
    this.assistant.classList.remove("thinking");
    const adv = a.advice as AssistantAdvice;
    this.assistant.className = `panel assistant hz-${adv.hazard}`;
    const chips = adv.cited_values.map((c) => `<span class="chip">${esc(c.name.replace(/_/g, " "))} ${esc(c.value)}</span>`).join("");
    this.assistant.innerHTML = `
      <div class="head">Mission Assistant · ${adv.hazard.toUpperCase()}<span>${esc(a.source)} · ${esc(a.latency_ms)} ms</span></div>
      ${a.question ? `<div class="q">“${esc(a.question)}”</div>` : ""}
      <div class="feel"><span class="icon">${FEELING_ICON[adv.feeling] ?? "·"}</span>${esc(adv.explanation)}</div>
      <div class="do"><b>Do:</b> ${esc(adv.action)}</div>
      ${adv.data_quality_note ? `<div class="note">${esc(adv.data_quality_note)}</div>` : ""}
      ${chips ? `<div class="chips">${chips}</div>` : ""}`;
  }
}
