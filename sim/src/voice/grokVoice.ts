// Grok Voice CAPCOM (PLAN.md §10.4). The browser talks to the xAI Realtime API directly with a short-lived
// token minted by the hub; every function call is executed by the hub's deterministic CommandHandler.
import type { HubClient } from "../net/hub";
import { Mic, PcmPlayer } from "./audio";

export type VoiceStatus = "offline" | "connecting" | "ready" | "listening" | "thinking" | "speaking";

interface PendingCall { call_id: string; name: string; arguments: string }

export class GrokVoice {
  status: VoiceStatus = "offline";
  onStatus: (s: VoiceStatus, detail?: string) => void = () => {};
  onTranscript: (role: "user" | "assistant" | "tool", text: string) => void = () => {};
  private ws: WebSocket | null = null;
  private mic = new Mic();
  private player = new PcmPlayer();
  private calls: PendingCall[] = [];
  private seenCalls = new Set<string>();
  private toolResolvers = new Map<string, (out: unknown) => void>();
  private expiresAt = 0;
  private assistantText = "";
  private connecting: Promise<void> | null = null;

  constructor(private hub: HubClient) {
    hub.on("voice.tool_result", (m) => this.toolResolvers.get(m.call_id)?.(m.output));
    this.mic.onChunk = (audio) => this.send({ type: "input_audio_buffer.append", audio });
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

  private async connect(): Promise<void> {
    this.set("connecting");
    const [cfgRes, tokRes] = await Promise.all([fetch("/api/voice/config"), fetch("/api/voice/token", { method: "POST" })]);
    if (!tokRes.ok) {
      this.set("offline", `token: ${(await tokRes.json().catch(() => ({}))).detail ?? tokRes.status}`);
      throw new Error("voice token unavailable");
    }
    const cfg = await cfgRes.json();
    const tok = await tokRes.json();
    this.expiresAt = tok.expires_at;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(cfg.url, [`xai-client-secret.${tok.token}`]);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("voice connect timeout")), 8000);
      ws.onopen = () => this.send({ type: "session.update", session: cfg.session });
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const ev = JSON.parse(e.data);
        if (ev.type === "session.updated") {
          clearTimeout(timer);
          this.set("ready");
          resolve();
        }
        this.handle(ev);
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("voice websocket error")); };
      ws.onclose = () => { if (this.status !== "offline") this.set("offline", "disconnected"); };
    });
    await this.mic.start();
  }

  // ------------------------------------------------------------------ push-to-talk
  async pttDown(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch {
      return;
    }
    this.player.stop(); // barge-in
    this.send({ type: "input_audio_buffer.clear" });
    await this.mic.setActive(true);
    this.set("listening");
  }

  async pttUp(): Promise<void> {
    if (this.status !== "listening") return;
    await this.mic.setActive(false);
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.set("thinking");
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
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      if (ev.delta) {
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
      for (const item of ev.response?.output ?? []) {
        if (item.type === "function_call") this.addCall({ call_id: item.call_id, name: item.name, arguments: item.arguments });
      }
      if (this.calls.length) void this.runCalls();
      else this.player.drained().then(() => { if (this.status === "speaking" || this.status === "thinking") this.set("ready"); });
    } else if (type === "error") {
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
  }
}
