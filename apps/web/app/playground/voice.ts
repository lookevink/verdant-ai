// Browser side of the sprout's voice: microphone → 16 kHz PCM → relay → Gemini Live, and Live's 24 kHz PCM → speakers.
// The relay (apps/voice) holds the Vertex credentials; this client only presents a ticket the API signed for the session.

type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type VoiceHandlers = {
  state(state: "connecting" | "ready" | "closed", reason?: string): void;
  /** Without a microphone the sprout still reads answers aloud. */
  microphone(available: boolean): void;
  userTranscript(text: string, finished: boolean): void;
  sproutTranscript(text: string): void;
  speaking(on: boolean): void;
  /** Answer each call; the result is sent back to Live. */
  toolCall(call: ToolCall): Promise<Record<string, unknown>>;
};

// Downmixes and posts 20 ms frames of 16-bit PCM. The capture context runs at 16 kHz, so the browser resamples.
const captureWorklet = `class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Int16Array(320); this.n = 0; }
  process(inputs) {
    const input = inputs[0]; if (!input || !input[0]) return true;
    for (let i = 0; i < input[0].length; i++) {
      let s = 0; for (const c of input) s += c[i]; s /= input.length;
      this.frame[this.n++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
      if (this.n === this.frame.length) { this.port.postMessage(this.frame.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("verdant-capture", Capture);`;

const toBase64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export class VoiceClient {
  private socket: WebSocket | null = null;
  private capture: { context: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null;
  private playback: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playhead = 0;
  private frames: Uint8Array[] = [];
  private muted = false;
  private raf = 0;
  constructor(private handlers: VoiceHandlers, private mouth: () => HTMLElement | null) {}

  async start(ticket: { url: string; ticket: string }) {
    this.handlers.state("connecting");
    // Both contexts are created inside the click that started voice, so autoplay rules allow them.
    this.playback = new AudioContext({ sampleRate: 24_000 });
    this.analyser = new AnalyserNode(this.playback, { fftSize: 512 });
    this.analyser.connect(this.playback.destination);
    let stream: MediaStream | null = null;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { /* denied or no device: speak only */ }
    this.handlers.microphone(Boolean(stream));
    if (stream) {
      const context = new AudioContext({ sampleRate: 16_000 });
      await context.audioWorklet.addModule(URL.createObjectURL(new Blob([captureWorklet], { type: "text/javascript" })));
      const node = new AudioWorkletNode(context, "verdant-capture");
      context.createMediaStreamSource(stream).connect(node);
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (this.muted) return;
        // Two 20 ms frames per message keep the request rate modest without adding noticeable latency.
        this.frames.push(new Uint8Array(event.data));
        if (this.frames.length >= 2) this.flushFrames();
      };
      this.capture = { context, stream, node };
    }

    const socket = new WebSocket(ticket.url);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", ticket: ticket.ticket }));
    socket.onmessage = event => this.receive(JSON.parse(String(event.data)));
    socket.onclose = event => { this.stop(); this.handlers.state("closed", event.reason || undefined); };
    this.animate();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) { this.frames = []; this.send({ type: "audio_end" }); }
  }
  /** Have the sprout read the analyst's answer aloud. */
  narrate(text: string) { this.send({ type: "narrate", text: text.slice(0, 1200) }); }

  stop() {
    cancelAnimationFrame(this.raf);
    this.socket?.close(); this.socket = null;
    this.capture?.stream.getTracks().forEach(track => track.stop());
    void this.capture?.context.close(); this.capture = null;
    this.flushPlayback();
    void this.playback?.close(); this.playback = null;
    this.mouth()?.style.setProperty("--mouth", "0");
  }

  private send(message: Record<string, unknown>) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private flushFrames() {
    if (!this.frames.length) return;
    const joined = new Uint8Array(this.frames.reduce((n, b) => n + b.length, 0));
    let offset = 0; for (const b of this.frames) { joined.set(b, offset); offset += b.length; }
    this.frames = [];
    this.send({ type: "audio", data: toBase64(joined) });
  }
  private receive(message: { type: string; data?: string; text?: string; finished?: boolean; calls?: ToolCall[]; reason?: string }) {
    switch (message.type) {
      case "ready": this.handlers.state("ready"); break;
      case "audio": this.play(message.data!); break;
      case "interrupted": this.flushPlayback(); break;
      case "input_transcript": this.handlers.userTranscript(message.text!, Boolean(message.finished)); break;
      case "output_transcript": this.handlers.sproutTranscript(message.text!); break;
      case "tool_call":
        for (const call of message.calls ?? []) void this.handlers.toolCall(call).then(response => this.send({ type: "tool_result", id: call.id, name: call.name, response }));
        break;
      case "closing": this.handlers.state("closed", message.reason); break;
    }
  }
  /** Schedule 24 kHz PCM chunks back to back. */
  private play(data: string) {
    const context = this.playback, analyser = this.analyser;
    if (!context || !analyser) return;
    const bytes = fromBase64(data), samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const buffer = context.createBuffer(1, samples.length, 24_000), channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000;
    const source = new AudioBufferSourceNode(context, { buffer });
    source.connect(analyser);
    this.playhead = Math.max(this.playhead, context.currentTime + 0.04);
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.sources.add(source);
    if (this.sources.size === 1) this.handlers.speaking(true);
    source.onended = () => { this.sources.delete(source); if (!this.sources.size) this.handlers.speaking(false); };
  }
  private flushPlayback() {
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* not started */ } }
    if (this.sources.size) this.handlers.speaking(false);
    this.sources.clear(); this.playhead = 0;
  }
  /** Drive the sprout's mouth from the output level. */
  private animate() {
    const samples = new Uint8Array(256);
    let smoothed = 0;
    const tick = () => {
      if (this.analyser) {
        this.analyser.getByteTimeDomainData(samples);
        let sum = 0; for (const s of samples) sum += ((s - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
        smoothed += (level - smoothed) * (level > smoothed ? 0.6 : 0.25);
        this.mouth()?.style.setProperty("--mouth", smoothed.toFixed(3));
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
