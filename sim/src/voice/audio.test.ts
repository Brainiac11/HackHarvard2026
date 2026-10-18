import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mic, peakOf } from "./audio";

describe("mic level", () => {
  it("is the loudest sample of a PCM16 chunk, 0..1", () => {
    expect(peakOf(new Int16Array(480))).toBe(0); // a muted or wrong input device: exact zeros
    expect(peakOf(new Int16Array([100, -16384, 3]))).toBe(0.5);
    expect(peakOf(new Int16Array([-32768, 32767]))).toBe(1);
  });
});

// The browser audio stack, reduced to what Mic touches. The "system default input" can be switched between calls.
class FakeTrack {
  stopped = false;
  private ended: (() => void)[] = [];
  constructor(public label: string) {}
  stop() { this.stopped = true; }
  addEventListener(_: "ended", f: () => void) { this.ended.push(f); }
  end() { this.ended.forEach((f) => f()); }
}
class FakeStream {
  constructor(public track: FakeTrack) {}
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
}
const graph = { contexts: 0, sources: [] as { stream: FakeStream; connected: boolean }[] };
class FakeContext {
  state = "running";
  audioWorklet = { addModule: async () => {} };
  constructor() { graph.contexts++; }
  async resume() {}
  async close() {}
  createMediaStreamSource(stream: FakeStream) {
    const s = { stream, connected: false, connect() { s.connected = true; }, disconnect() { s.connected = false; } };
    graph.sources.push(s);
    return s;
  }
}
class FakeNode {
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: string) => { if (m === "off") this.port.onmessage?.({ data: "flushed" }); },
  };
}

let systemDefault = "Digital Microphone";
const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
  expect((c.audio as MediaTrackConstraints).deviceId).toBeUndefined(); // no pinned device: the current default
  return new FakeStream(new FakeTrack(systemDefault));
});

beforeEach(() => {
  graph.contexts = 0;
  graph.sources = [];
  systemDefault = "Digital Microphone";
  getUserMedia.mockClear();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:worklet" });
});
afterEach(() => vi.unstubAllGlobals());

async function turn(mic: Mic): Promise<FakeStream> {
  await mic.start();
  await mic.setActive(true);
  const stream = graph.sources.at(-1)!.stream;
  await mic.setActive(false);
  return stream;
}

describe("push-to-talk microphone", () => {
  it("records each turn from whatever the system default input is at that press", async () => {
    const mic = new Mic();
    const first = await turn(mic);
    systemDefault = "USB Headset"; // switched in the OS between turns, no reload
    await mic.start();
    expect(mic.label).toBe("USB Headset");
    await mic.setActive(true);
    await mic.setActive(false);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.track.label).toBe("Digital Microphone");
    expect(graph.contexts).toBe(1); // the context and worklet are built once; only the stream is new
  });

  it("lets go of the input when a turn ends, so the mic is off between turns", async () => {
    const mic = new Mic();
    const stream = await turn(mic);
    expect(stream.track.stopped).toBe(true);
    expect(graph.sources[0].connected).toBe(false);
    expect(mic.label).toBe("");
  });

  it("a device that disappears mid-turn is released, and the next press opens the new default", async () => {
    const mic = new Mic();
    await mic.start();
    await mic.setActive(true);
    const unplugged = graph.sources[0].stream;
    unplugged.track.end();
    expect(graph.sources[0].connected).toBe(false);
    await mic.setActive(false);
    systemDefault = "Laptop Microphone";
    await mic.start();
    expect(mic.label).toBe("Laptop Microphone");
    expect(graph.sources[1].connected).toBe(true);
  });

  it("a refused stream leaves nothing open and the next press tries again", async () => {
    const mic = new Mic();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("busy"), { name: "NotReadableError" }));
    await expect(mic.start()).rejects.toThrow("busy");
    expect(mic.label).toBe("");
    await mic.start();
    expect(mic.label).toBe("Digital Microphone");
    expect(graph.contexts).toBe(1);
  });
});
