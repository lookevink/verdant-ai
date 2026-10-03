"use client";
import { useState } from "react";
import { onPhase, readPhase } from "./sky";

type Engine = { set(wind: number, rustle: number): void; fade(on: boolean): void };
// Ambient sound is synthesized (nothing to download); the field drives it through this module state.
export const sound: { engine: Engine | null } = { engine: null };

function loop(audio: AudioContext, brown: boolean) {
  const rate = audio.sampleRate, length = rate * 4, fade = rate / 4, raw = new Float32Array(length + fade);
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    raw[i] = brown ? last * 3.5 : white * 0.5;
  }
  const buffer = audio.createBuffer(1, length, rate), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = i < fade ? raw[i]! * (i / fade) + raw[length + i]! * (1 - i / fade) : raw[i]!;
  const source = audio.createBufferSource();
  source.buffer = buffer; source.loop = true; source.start();
  return source;
}

function startSound(): Engine {
  const audio = new AudioContext();
  const master = audio.createGain(), wind = audio.createGain(), rustle = audio.createGain(), crickets = audio.createGain();
  const low = new BiquadFilterNode(audio, { type: "lowpass", frequency: 400, Q: 0.5 });
  const leaves = new BiquadFilterNode(audio, { type: "bandpass", frequency: 4200, Q: 0.8 });
  master.gain.value = 0; wind.gain.value = 0.1; rustle.gain.value = 0; crickets.gain.value = 0;
  loop(audio, true).connect(low).connect(wind).connect(master);
  loop(audio, false).connect(leaves).connect(rustle).connect(master);
  // Crickets at dusk: a high tone gated by a fast trill and a slower chirp rhythm.
  for (const [pitch, rhythm] of [[4400, 1.3], [4750, 0.9]] as const) {
    const tone = new OscillatorNode(audio, { frequency: pitch });
    const trill = new OscillatorNode(audio, { type: "square", frequency: 28 }), pulse = new OscillatorNode(audio, { type: "square", frequency: rhythm });
    const flutter = new GainNode(audio, { gain: 0.5 }), gate = new GainNode(audio, { gain: 0.5 });
    trill.connect(new GainNode(audio, { gain: 0.5 })).connect(flutter.gain);
    pulse.connect(new GainNode(audio, { gain: 0.5 })).connect(gate.gain);
    tone.connect(flutter).connect(gate).connect(crickets);
    tone.start(); trill.start(); pulse.start();
  }
  crickets.connect(master);
  master.connect(audio.destination);
  const night = () => crickets.gain.setTargetAtTime(readPhase() === "dusk" ? 0.02 : 0, audio.currentTime, 0.8);
  night(); onPhase(night);
  let wanted = false;
  return {
    set(level, rustling) {
      const now = audio.currentTime;
      wind.gain.setTargetAtTime(0.05 + level * 0.45, now, 0.4);
      low.frequency.setTargetAtTime(240 + level * 1100, now, 0.5);
      rustle.gain.setTargetAtTime(rustling, now, 0.06);
    },
    fade(on) {
      wanted = on;
      if (on) void audio.resume();
      master.gain.setTargetAtTime(on ? 1 : 0, audio.currentTime, on ? 0.6 : 0.25);
      if (!on) setTimeout(() => { if (!wanted) void audio.suspend(); }, 1500);
    },
  };
}

export function SoundToggle() {
  const [on, setOn] = useState(false);
  function toggle() {
    sound.engine ??= startSound();
    sound.engine.fade(!on);
    setOn(!on);
  }
  return <button type="button" className="pill" aria-pressed={on} aria-label="Ambient sound" onClick={toggle}>
    <span className="bars" aria-hidden="true"><i /><i /><i /><i /></span><span className="pill-label">{on ? "Sound on" : "Sound off"}</span>
  </button>;
}
