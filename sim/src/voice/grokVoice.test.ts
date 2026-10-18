import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../net/hub";
import { GrokVoice } from "./grokVoice";

// the browser audio graph is replaced by a mic whose chunks (and opening) the tests drive by hand
vi.mock("./audio", () => ({
  Mic: class {
    onChunk: (b64: string, peak: number) => void = () => {};
    opening: Promise<void> = Promise.resolve();
    active: boolean[] = [];
    released = 0;
    label = "";
    async start() { return this.opening; }
    async setActive(on: boolean) { this.active.push(on); }
    release() { this.released++; }
  },
  PcmPlayer: class {
    played: string[] = [];
    enqueue(b64: string) { this.played.push(b64); }
    drained() { return Promise.resolve(); }
    stop() {}
  },
}));

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string, public protocols: string[]) { FakeWS.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.drop(1005); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(ev: object) { this.onmessage?.({ data: JSON.stringify(ev) }); }
  drop(code: number, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  types() { return this.sent.map((e) => e.type); }
}

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
/** V held for a while (a real sentence), then released. */
const release = async (voice: GrokVoice, heldMs = 1500) => { await vi.advanceTimersByTimeAsync(heldMs); await voice.pttUp(); };

let fetchMock: ReturnType<typeof vi.fn>;

function setup() {
  const hub = { on: vi.fn(), send: vi.fn() };
  const voice = new GrokVoice(hub as unknown as HubClient);
  const log: string[] = [];
  voice.onStatus = (s, d) => log.push(d ? `${s} (${d})` : s);
  const transcript: string[] = [];
  voice.onTranscript = (role, text) => transcript.push(`${role}: ${text}`);
  const v = voice as any;
  return { voice, hub, log, transcript, mic: v.mic, player: v.player, last: () => log[log.length - 1] };
}

/** V down until the session is up and listening; returns the socket. */
async function talk(voice: GrokVoice): Promise<FakeWS> {
  const down = voice.pttDown();
  await settle();
  const ws = FakeWS.all[FakeWS.all.length - 1];
  ws.open();
  ws.emit({ type: "session.updated", session: {} });
  await down;
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.all = [];
  fetchMock = vi.fn(async (url: string) => url.endsWith("/token")
    ? reply(200, { token: "tok", expires_at: Date.now() / 1000 + 300 })
    : reply(200, { url: "wss://api.x.ai/v1/realtime?model=m", session: { voice: "eve" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("grok voice push-to-talk", () => {
  it("records while connecting, then streams, commits and asks for a reply", async () => {
    const { voice, mic } = setup();
    const down = voice.pttDown();
    await settle();
    const ws = FakeWS.all[0];
    expect(ws.protocols).toEqual(["xai-client-secret.tok"]);
    mic.onChunk("EARLY", 0.3); // spoken before the session is up: held, then sent first
    ws.open();
    expect(ws.sent[0]).toMatchObject({ type: "session.update", session: { voice: "eve" } });
    ws.emit({ type: "session.updated" });
    await down;
    expect(voice.status).toBe("listening");
    mic.onChunk("LIVE", 0.2);
    await release(voice);
    expect(ws.types()).toEqual(["session.update", "input_audio_buffer.clear", "input_audio_buffer.append",
      "input_audio_buffer.append", "input_audio_buffer.commit", "response.create"]);
    expect(ws.sent.filter((e) => e.audio).map((e) => e.audio)).toEqual(["EARLY", "LIVE"]);
    expect(voice.status).toBe("thinking");
  });

  it("drops a silent turn instead of letting Grok answer nothing, and says why", async () => {
    const { voice, mic, transcript, last } = setup();
    const ws = await talk(voice);
    mic.onChunk("QUIET", 0.001);
    await release(voice);
    expect(ws.types()).not.toContain("input_audio_buffer.commit");
    expect(ws.types()).not.toContain("response.create");
    expect(last()).toBe("ready (heard nothing, mic peak -60 dBFS)");
    expect(transcript.at(-1)).toMatch(/no sound from the microphone/);
    await talk(voice); // a muted or wrong input device delivers exact zeros
    mic.onChunk("ZEROS", 0);
    await release(voice);
    expect(last()).toBe("ready (heard nothing: the mic sends pure silence)");
  });

  it("reports the level while V is held and clears it after", async () => {
    const { voice, mic } = setup();
    const levels: (number | null)[] = [];
    voice.onLevel = (p) => levels.push(p);
    await talk(voice);
    mic.onChunk("A", 0.25);
    await release(voice);
    mic.onChunk("AFTER", 0.5); // the worklet's tail after the turn: neither sent nor shown
    expect(levels).toEqual([0.25, null]);
  });

  it("V released while still connecting stops recording there, and the speech so far is still sent", async () => {
    const { voice, mic } = setup();
    const down = voice.pttDown();
    await settle();
    const ws = FakeWS.all[0];
    mic.onChunk("EARLY", 0.3);
    await release(voice, 800);
    expect(mic.active).toEqual([true, false]); // off at the release, not once the session is up
    ws.open();
    ws.emit({ type: "session.updated" });
    await down;
    expect(ws.types()).toEqual(["session.update", "input_audio_buffer.clear", "input_audio_buffer.append",
      "input_audio_buffer.commit", "response.create"]);
    expect(voice.status).toBe("thinking");
  });

  it("a tap of V is not sent (nor blamed on the microphone): it says to hold V", async () => {
    const { voice, mic, transcript, last } = setup();
    const ws = await talk(voice);
    mic.onChunk("CLICK", 0.2); // the key's own click is loud enough to pass for sound
    await release(voice, 100);
    expect(ws.types()).not.toContain("input_audio_buffer.commit");
    expect(ws.types()).not.toContain("response.create");
    expect(last()).toBe("ready (too short: hold V while you talk)");
    expect(transcript).toEqual([]);
  });
});

describe("grok voice failures end on a status that says what broke", () => {
  it("a refused WebSocket handshake goes offline (not a silent 'connecting') and the next press retries", async () => {
    const { voice, last } = setup();
    const down = voice.pttDown();
    await settle();
    FakeWS.all[0].onerror?.();
    FakeWS.all[0].drop(1006);
    await down;
    expect(voice.status).toBe("offline");
    expect(last()).toMatch(/refused the connection: check the network and xAI credits/);
    await voice.pttUp();
    void voice.pttDown();
    await settle();
    expect(FakeWS.all).toHaveLength(2);
  });

  it("no session.updated within 8 s times out with Grok's own error, and closes the socket", async () => {
    const { voice, last } = setup();
    const down = voice.pttDown();
    await settle();
    const ws = FakeWS.all[0];
    ws.open();
    ws.emit({ type: "error", error: { message: "unknown field 'foo'" } });
    await vi.advanceTimersByTimeAsync(8000);
    await down;
    expect(last()).toBe("offline (no answer from Grok: unknown field 'foo'; hold V to retry)");
    expect(ws.readyState).toBe(3);
  });

  it("token and hub failures", async () => {
    const { voice, last } = setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/token") ? reply(503, { detail: "XAI_API_KEY is not set" }) : reply(200, {}));
    await voice.pttDown();
    expect(last()).toBe("offline (token: XAI_API_KEY is not set; hold V to retry)");
    await voice.pttUp();
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await voice.pttDown();
    expect(last()).toBe("offline (hub unreachable; hold V to retry)");
  });

  it("a session that drops later goes offline with the close code", async () => {
    const { voice, last } = setup();
    const ws = await talk(voice);
    ws.drop(1011, "server error");
    expect(last()).toBe("offline (disconnected (server error))");
  });

  it("a blocked microphone is reported even after V came up", async () => {
    const { voice, mic, transcript, last } = setup();
    mic.opening = Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    const down = voice.pttDown();
    await voice.pttUp(); // released to click the permission prompt
    await down;
    expect(last()).toMatch(/microphone blocked: allow it for this site/);
    expect(transcript.at(-1)).toBe("tool: microphone unavailable: NotAllowedError: Permission denied");
    expect(FakeWS.all).toHaveLength(0);
    expect(mic.released).toBe(1);
  });

  it("V released while the mic was still opening says to hold it, and the next press works", async () => {
    const { voice, mic, last } = setup();
    let grant!: () => void;
    mic.opening = new Promise<void>((r) => (grant = r));
    const down = voice.pttDown();
    await voice.pttUp();
    grant();
    await down;
    expect(last()).toBe("offline (mic on: hold V while you talk)");
    expect(mic.released).toBe(1); // the input opened after the release is let go, not left recording
    await talk(voice);
    expect(voice.status).toBe("listening");
  });

  it("the listening status names the input in use", async () => {
    const { voice, mic, last } = setup();
    mic.label = "Headset Microphone";
    await talk(voice);
    expect(last()).toBe("listening (Headset Microphone)");
  });
});

describe("grok voice barge-in", () => {
  it("V during a reply cancels it on the server and keeps its leftover audio and tool calls quiet", async () => {
    const { voice, mic, player, hub, transcript } = setup();
    const ws = await talk(voice);
    mic.onChunk("Q", 0.3);
    await release(voice);
    ws.emit({ type: "response.created", response: { id: "r1" } });
    ws.emit({ type: "response.output_audio.delta", delta: "SAY1" });
    expect(voice.status).toBe("speaking");
    void voice.pttDown();
    await settle();
    expect(ws.types().at(-2)).toBe("response.cancel");
    ws.emit({ type: "response.output_audio.delta", delta: "SAY2" });
    ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "get_profile", arguments: "{}" });
    ws.emit({ type: "response.done", response: { status: "cancelled", output: [] } });
    ws.emit({ type: "error", error: { message: "Cancellation failed: no active response found" } });
    await settle();
    expect(player.played).toEqual(["SAY1"]);
    expect(hub.send).not.toHaveBeenCalled();
    expect(transcript.filter((t) => t.includes("error"))).toEqual([]);
    expect(voice.status).toBe("listening");
  });

  it("tool calls of a finished reply still run on the hub", async () => {
    const { voice, mic, hub } = setup();
    const ws = await talk(voice);
    mic.onChunk("Q", 0.3);
    await release(voice);
    ws.emit({ type: "response.created" });
    ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "get_equipment_status",
      arguments: "{\"equipment\":\"rover\"}" });
    ws.emit({ type: "response.done", response: { status: "completed", output: [] } });
    await settle();
    expect(hub.send).toHaveBeenCalledWith({ t: "voice.tool_call", call_id: "c1", name: "get_equipment_status",
      args: { equipment: "rover" } });
  });
});
