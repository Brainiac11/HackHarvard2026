// Grok Voice CAPCOM (PLAN.md §10.4). The browser talks to the xAI Realtime API directly with a short-lived
// token minted by the hub; every function call is executed by the hub's deterministic CommandHandler.
import type { HubClient } from "../net/hub";
import { Mic, PcmPlayer } from "./audio";

export type VoiceStatus = "offline" | "connecting" | "ready" | "listening" | "thinking" | "speaking";

interface PendingCall { call_id: string; name: string; arguments: string }

const REPLY_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 8000;
// A turn whose loudest sample stays under this (-46 dBFS) carried no voice. Grok answers a committed empty turn with
// an invented reply (seen 2026-10-17), so such a turn is dropped and the HUD says to check the microphone.
export const SILENT_PEAK = 0.005;
// A tap, not a sentence: xAI answers such a blip with an invented reply or not at all (seen 2026-10-17)
const MIN_HOLD_MS = 300;

// getUserMedia failures (DOMException names), as the astronaut should read them
const MIC_HINTS: Record<string, string> = {
  NotAllowedError: "blocked: allow it for this site (address bar icon), then hold V",
  NotFoundError: "none found: plug one in or pick an input device",
  NotReadableError: "busy or blocked by the OS: check the input device in sound settings",
  OverconstrainedError: "no usable input device",
};

export const dbfs = (peak: number): string => `${Math.round(20 * Math.log10(peak))} dBFS`;

export class GrokVoice {
  status: VoiceStatus = "offline";
  onStatus: (s: VoiceStatus, detail?: string) => void = () => {};
  onTranscript: (role: "user" | "assistant" | "tool", text: string) => void = () => {};
  /** Mic level while V is held (peak of the latest 20 ms, 0..1); null when the turn ends. */
  onLevel: (peak: number | null) => void = () => {};
  private ws: WebSocket | null = null;
  private mic = new Mic();
  private player = new PcmPlayer();
  private calls: PendingCall[] = [];
  private seenCalls = new Set<string>();
  private toolResolvers = new Map<string, (out: unknown) => void>();
  private expiresAt = 0;
  private assistantText = "";
  private connecting: Promise<void> | null = null;
  // push-to-talk audio is held locally until the session is ready, then streamed; dropped between turns
  private turn: "idle" | "buffering" | "live" = "idle";
  private early: string[] = [];
  private held = false;
  private pressedAt = 0;
  private heldMs = 0;
  private turnPeak = 0;
  private responding = false; // between response.created and response.done: a barge-in has to cancel it
  private replyTimer = 0;

  constructor(private hub: HubClient) {
    hub.on("voice.tool_result", (m) => this.toolResolvers.get(m.call_id)?.(m.output));
    this.mic.onChunk = (audio, peak) => {
      if (this.turn === "idle") return;
      this.turnPeak = Math.max(this.turnPeak, peak);
      this.onLevel(peak);
      if (this.turn === "live") this.send({ type: "input_audio_buffer.append", audio });
      else this.early.push(audio);
    };
  }

  private set(s: VoiceStatus, detail?: string): void {
    this.status = s;
    this.onStatus(s, detail);
  }

  private send(ev: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  async ensureConnected(): Promise<void> {
    const fresh = this.ws?.readyState === WebSocket.OPEN && Date.now() / 1000 < this.expiresAt - 30;
    if (fresh) return;
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** Every failure ends on an "offline" status that says what broke, never on a silent "connecting". */
  private async connect(): Promise<void> {
    this.set("connecting", this.turn === "buffering" ? "recording, keep talking" : undefined);
    try {
      await this.open();
    } catch (e) {
      this.set("offline", `${(e as Error).message}; hold V to retry`);
      throw e;
    }
  }

  private async open(): Promise<void> {
    const [cfgRes, tokRes] = await Promise.all([fetch("/api/voice/config"), fetch("/api/voice/token", { method: "POST" })])
      .catch(() => { throw new Error("hub unreachable"); });
    if (!tokRes.ok) {
      const detail = (await tokRes.json().catch(() => ({}))).detail;
      throw new Error(`token: ${detail ?? `HTTP ${tokRes.status}, is the hub running?`}`);
    }
    if (!cfgRes.ok) throw new Error(`config: ${cfgRes.status}`);
    const cfg = await cfgRes.json();
    const tok = await tokRes.json();
    this.expiresAt = tok.expires_at;
    await new Promise<void>((resolve, reject) => {
      const stale = this.ws;
      const ws = new WebSocket(cfg.url, [`xai-client-secret.${tok.token}`]);
      this.ws = ws;
      stale?.close(); // token refresh: the old session must not keep feeding events or report a disconnect
      let ready = false, lastError = "";
      const fail = (why: string) => {
        clearTimeout(timer);
        reject(new Error(why)); // first: the close below reports again, and only the first reason counts
        ws.close();
      };
      const timer = setTimeout(() => fail(`no answer from Grok${lastError ? `: ${lastError}` : ""}`), CONNECT_TIMEOUT_MS);
      ws.onopen = () => this.send({ type: "session.update", session: cfg.session });
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const ev = JSON.parse(e.data);
        if (ev.type === "session.updated" && !ready) {
          ready = true;
          clearTimeout(timer);
          this.set("ready");
          resolve();
        } else if (ev.type === "error" && !ready) {
          lastError = ev.error?.message ?? "";
        }
        this.handle(ev);
      };
      // a refused handshake (e.g. xAI's 402 when the account is out of credits) only shows up as error + close 1006
      ws.onerror = () => {};
      ws.onclose = (e) => {
        if (!ready) fail(e.code === 1006 ? "Grok refused the connection: check the network and xAI credits"
          : `Grok closed the session: ${e.reason || e.code}`);
        else if (this.ws === ws && this.status !== "offline") this.set("offline", `disconnected (${e.reason || e.code})`);
      };
    });
  }

  // ------------------------------------------------------------------ push-to-talk
  async pttDown(): Promise<void> {
    if (this.turn !== "idle") return;
    this.held = true;
    this.pressedAt = Date.now();
    this.player.stop(); // barge-in: CAPCOM stops here, and the rest of its reply is cancelled on the server
    if (this.responding) this.send({ type: "response.cancel" });
    // record from the moment V goes down; the first press also has to open the session (~1 s) and the mic
    this.turn = "buffering";
    this.early = [];
    this.turnPeak = 0;
    try {
      await this.mic.start();
      if (this.held) await this.mic.setActive(true);
    } catch (e) {
      this.turn = "idle";
      this.mic.release();
      const err = e as Error;
      this.set(this.status, `microphone ${MIC_HINTS[err.name] ?? (err.message || String(err))}`);
      this.onTranscript("tool", `microphone unavailable: ${err.name}: ${err.message}`);
      return;
    }
    if (!this.held) { // V came up while the mic was opening (the first press waits on the permission prompt)
      this.turn = "idle";
      this.mic.release();
      this.set(this.status, "mic on: hold V while you talk");
      return;
    }
    try {
      await this.ensureConnected();
    } catch {
      this.turn = "idle"; // connect() has put the reason on the status line
      this.onLevel(null);
      await this.mic.setActive(false);
      return;
    }
    this.send({ type: "input_audio_buffer.clear" });
    for (const audio of this.early.splice(0)) this.send({ type: "input_audio_buffer.append", audio });
    this.turn = "live";
    this.set("listening", this.mic.label || undefined); // the input in use: it follows the system default
    if (!this.held) await this.endTurn(); // V came up while the session was still connecting
  }

  async pttUp(): Promise<void> {
    this.held = false;
    this.heldMs = Date.now() - this.pressedAt;
    if (this.turn === "live") await this.endTurn();
    else if (this.turn === "buffering") { // still connecting: recording stops here, the turn is sent once it is up
      await this.mic.setActive(false);
      this.onLevel(null);
    }
  }

  private async endTurn(): Promise<void> {
    await this.mic.setActive(false); // resolves after the worklet's last chunk has been appended
    this.turn = "idle";
    this.onLevel(null);
    if (this.heldMs < MIN_HOLD_MS) {
      this.send({ type: "input_audio_buffer.clear" });
      this.set("ready", "too short: hold V while you talk");
      return;
    }
    if (this.turnPeak < SILENT_PEAK) {
      this.send({ type: "input_audio_buffer.clear" });
      this.set("ready", this.turnPeak > 0 ? `heard nothing, mic peak ${dbfs(this.turnPeak)}` : "heard nothing: the mic sends pure silence");
      this.onTranscript("tool", "no sound from the microphone: check the input device, its level and mute switch");
      return;
    }
    // nothing may be appended after the commit: xAI hears it as the user talking again and drops its reply
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.set("thinking");
    this.expectReply();
  }

  /** Never sit on "thinking" forever if a reply is lost. */
  private expectReply(): void {
    clearTimeout(this.replyTimer);
    this.replyTimer = window.setTimeout(() => {
      if (this.status === "thinking") this.set("ready", "no reply, hold V to try again");
    }, REPLY_TIMEOUT_MS);
  }

  async sendText(text: string): Promise<boolean> {
    try {
      await this.ensureConnected();
    } catch {
      return false;
    }
    this.onTranscript("user", text);
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
    this.set("thinking");
    this.expectReply();
    return true;
  }

  /** Have CAPCOM speak a fixed line (e.g. Mission Assistant advice) without a model turn. */
  speak(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "conversation.item.create", item: { type: "force_message", role: "assistant",
      content: [{ type: "output_text", text }] } });
  }

  // ------------------------------------------------------------------ server events
  private handle(ev: any): void {
    const type: string = ev.type;
    if (type === "response.created") {
      this.responding = true;
      this.assistantText = "";
    } else if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      if (ev.delta && this.turn === "idle") { // while V is held, a cancelled reply's last chunks stay silent
        this.player.enqueue(ev.delta);
        if (this.status !== "speaking") this.set("speaking");
      }
    } else if (type.includes("transcript") && type.endsWith(".delta") && type.startsWith("response")) {
      this.assistantText += ev.delta ?? "";
    } else if (type.includes("transcript") && (type.endsWith(".done") || type.endsWith(".completed"))) {
      const text = ev.transcript ?? "";
      if (type.startsWith("conversation.item.input_audio")) this.onTranscript("user", text);
      else if (text || this.assistantText) this.onTranscript("assistant", text || this.assistantText);
      if (!type.startsWith("conversation")) this.assistantText = "";
    } else if (type === "response.function_call_arguments.done") {
      this.addCall({ call_id: ev.call_id, name: ev.name, arguments: ev.arguments });
    } else if (type === "response.done") {
      this.responding = false;
      if (ev.response?.status === "cancelled") this.calls = []; // barged in: the astronaut has moved on
      else for (const item of ev.response?.output ?? []) {
        if (item.type === "function_call") this.addCall({ call_id: item.call_id, name: item.name, arguments: item.arguments });
      }
      if (this.calls.length) void this.runCalls();
      else this.player.drained().then(() => { if (this.status === "speaking" || this.status === "thinking") this.set("ready"); });
    } else if (type === "error") {
      // a barge-in raced the end of the reply: "Cancellation failed: no active response found" is harmless
      if (ev.error?.message?.startsWith("Cancellation failed")) return;
      console.warn("grok voice error", ev);
      this.onTranscript("tool", `error: ${ev.error?.message ?? JSON.stringify(ev).slice(0, 160)}`);
      if (this.status === "thinking") this.set("ready");
    }
  }

  private addCall(c: PendingCall): void {
    if (!c.call_id || this.seenCalls.has(c.call_id)) return;
    this.seenCalls.add(c.call_id);
    this.calls.push(c);
  }

  private async runCalls(): Promise<void> {
    const calls = this.calls.splice(0);
    this.set("thinking");
    const outputs = await Promise.all(calls.map(async (c) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments || "{}"); } catch { /* model sent bad JSON: handler reports it */ }
      this.onTranscript("tool", `${c.name}(${JSON.stringify(args)})`);
      const out = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "hub timeout" }), 6000);
        this.toolResolvers.set(c.call_id, (o) => { clearTimeout(timer); resolve(o); });
        this.hub.send({ t: "voice.tool_call", call_id: c.call_id, name: c.name, args });
      });
      this.toolResolvers.delete(c.call_id);
      return { call_id: c.call_id, output: out };
    }));
    for (const o of outputs) {
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.call_id,
        output: JSON.stringify(o.output) } });
    }
    await this.player.drained(); // don't talk over the current sentence (xAI guidance)
    this.send({ type: "response.create" });
    this.expectReply();
  }
}
