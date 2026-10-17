// Audio plumbing for Grok Voice: mic capture -> PCM16 @ 24 kHz chunks, and gapless PCM16 playback.

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 24000; this.pos = 0; this.prev = 0; this.buf = []; this.on = false;
    this.port.onmessage = (e) => {
      this.on = e.data === "on";
      if (!this.on) { this.flush(); this.port.postMessage("flushed"); }
    }; }
  flush() { if (this.buf.length) { this.port.postMessage(Int16Array.from(this.buf).buffer); this.buf = []; } }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.on) return true;
    // linear resample from the context rate to 24 kHz (index -1 is the previous block's last sample)
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const s = (i < 0 ? this.prev : ch[i]) * (1 - f) + ch[i + 1] * f;
      this.buf.push(Math.max(-32768, Math.min(32767, Math.round(s * 32767))));
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    if (this.buf.length >= 480) this.flush(); // 20 ms
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

export function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Mic {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  private flushed: (() => void)[] = [];
  onChunk: (b64: string) => void = () => {};

  start(): Promise<void> {
    this.opening ??= this.open().catch((e) => { this.opening = null; throw e; });
    return this.opening;
  }

  private async open(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e) => {
      if (e.data === "flushed") this.flushed.splice(0).forEach((r) => r());
      else this.onChunk(toBase64(e.data as ArrayBuffer));
    };
    this.ctx.createMediaStreamSource(stream).connect(this.node);
  }

  /** Turning off resolves once the last captured samples have been delivered to onChunk. */
  async setActive(on: boolean): Promise<void> {
    await this.ctx?.resume();
    if (!this.node) return;
    const done = on ? Promise.resolve() : new Promise<void>((r) => {
      this.flushed.push(r);
      setTimeout(r, 300); // worklet gone quiet: don't hang the turn
    });
    this.node.port.postMessage(on ? "on" : "off");
    await done;
  }
}

export class PcmPlayer {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private drainWaiters: (() => void)[] = [];

  get playing(): boolean { return this.sources.size > 0; }

  enqueue(b64: string): void {
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    const buf = this.ctx.createBuffer(1, pcm.length, 24000);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime + 0.02, this.next);
    src.start(start);
    this.next = start + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.drainWaiters.splice(0).forEach((r) => r());
    };
    this.ctx.resume();
  }

  /** Resolves once everything queued has finished playing. */
  drained(): Promise<void> {
    return this.sources.size ? new Promise((r) => this.drainWaiters.push(r)) : Promise.resolve();
  }

  stop(): void {
    this.sources.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
    this.sources.clear();
    this.next = 0;
    this.drainWaiters.splice(0).forEach((r) => r());
  }
}
