"use client";
import { useEffect, useRef, useState } from "react";

type RGB = readonly [number, number, number];
type Blade = { x: number; y: number; t: number; h: number; w: number; lean: number; phase: number; bend: number; delay: number; kind: number; odd: boolean };
type Flower = { blade: Blade; r: number; color: string; eye: string };
type Band = { blades: Blade[]; flowers: Flower[]; fills: CanvasGradient[] };

// Depth t runs from 0 at the horizon to 1 at the bottom edge. On flat ground apparent size grows
// linearly with t, so blades shrink into a fine texture toward the horizon. Distance fades into the
// sky's haze (aerial perspective); tips warm toward sunlight, bases cool into shade, and the three
// grass varieties cluster into patches the way a real meadow does.
const haze: RGB = [216, 236, 222];
const kinds: { base: RGB; tip: RGB; lit: RGB }[] = [
  { base: [9, 70, 38], tip: [112, 204, 78], lit: [208, 244, 128] },
  { base: [52, 88, 24], tip: [190, 214, 92], lit: [244, 246, 170] },
  { base: [5, 60, 46], tip: [78, 182, 120], lit: [182, 236, 184] },
];
const blooms = [["#ff5b3a", "#3a1a10"], ["#ffcf33", "#f59e0b"], ["#fbfbf0", "#ffcf33"]] as const;
const edges = [0.3, 0.42, 0.54, 0.66, 0.78, 0.9, 1.15];
const blend = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const css = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
const hazeAt = (t: number) => Math.pow(1 - Math.min(t, 1), 3) * 0.9;
const scaleAt = (t: number) => Math.max(0.012, Math.pow(t, 1.1));
const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);
function seeded(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Ambient sound is synthesized (no download) and shared with the toggle through module state.
type Engine = { audio: AudioContext; set(wind: number, rustle: number): void; fade(on: boolean): void };
const sound: { engine: Engine | null } = { engine: null };

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
  const master = audio.createGain(), wind = audio.createGain(), rustle = audio.createGain();
  const low = new BiquadFilterNode(audio, { type: "lowpass", frequency: 400, Q: 0.5 });
  const leaves = new BiquadFilterNode(audio, { type: "bandpass", frequency: 4200, Q: 0.8 });
  master.gain.value = 0; wind.gain.value = 0.1; rustle.gain.value = 0;
  loop(audio, true).connect(low).connect(wind).connect(master);
  loop(audio, false).connect(leaves).connect(rustle).connect(master);
  master.connect(audio.destination);
  let wanted = false;
  return {
    audio,
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
  return <button type="button" className="sound" aria-pressed={on} onClick={toggle}>
    <span className="bars" aria-hidden="true"><i /><i /><i /><i /></span>{on ? "Sound on" : "Sound off"}
  </button>;
}

export function Field() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const backdrop = document.createElement("canvas");
    const pointer = { x: -1e4, y: -1e4, vx: 0, speed: 0, lastX: 0, lastY: 0 };
    const gusts: { x: number; speed: number; size: number; power: number }[] = [];
    const shades = [{ x: 0.15, t: 0.55, size: 0.55, speed: 16 }, { x: 0.8, t: 0.28, size: 0.42, speed: 11 }];
    const flies = [{ x: 0.3, y: 0.42, heading: 0.4, phase: 0, color: "#fffbe8" }, { x: 0.72, y: 0.6, heading: 2.8, phase: 2.4, color: "#ffe680" }];
    const motes = Array.from({ length: 28 }, (_, i) => ({ x: Math.random(), y: Math.random(), size: 0.6 + Math.random() * 1.6, speed: 0.25 + Math.random() * 0.6, phase: i }));
    let bands: Band[] = [], shadow: CanvasGradient | null = null;
    let width = 0, height = 0, horizon = 0, depth = 0, tallest = 0, widest = 0, dpr = 1;
    let frame = 0, visible = true, born = 0, last = 0, nextGust = 1.2, sampled = 0, cost = 0, sparse = false, placed = false, tick = 0;

    function patch(x: number, t: number, s: number, random: () => number) {
      const gx = (x - width / 2) / Math.max(s, 0.05), gz = 1 / Math.max(t, 0.02);
      const n = Math.sin(gx * 0.0035 + gz * 0.8) * 0.6 + Math.sin(gx * 0.0011 - gz * 1.9 + 1.3) * 0.4 + (random() - 0.5) * 0.9;
      return n > 0.42 ? 1 : n < -0.5 ? 2 : 0;
    }

    function paintBackdrop(random: () => number) {
      backdrop.width = canvas!.width; backdrop.height = canvas!.height;
      const b = backdrop.getContext("2d")!;
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ridge = (top: (x: number) => number, from: string, to: string) => {
        const fill = b.createLinearGradient(0, horizon - depth * 0.14, 0, horizon);
        fill.addColorStop(0, from); fill.addColorStop(1, to);
        b.beginPath(); b.moveTo(0, horizon + 1);
        for (let x = 0; x <= width + 8; x += 8) b.lineTo(x, top(x));
        b.lineTo(width, horizon + 1); b.fillStyle = fill; b.fill();
      };
      ridge(x => horizon - depth * (0.075 + 0.045 * Math.sin(x * 0.0021 + 1) + 0.02 * Math.sin(x * 0.0067 + 4)), "#cfe6dc", "#c3ded3");
      // A hazy treeline: irregular clumps of overlapping crowns with sunlit tops, paler in the back row.
      const clump = (x: number) => (Math.sin(x * 0.009 + 1) + Math.sin(x * 0.023 + 3) * 0.6 + Math.sin(x * 0.0041) * 0.8) / 2.4;
      ridge(x => horizon - depth * 0.009 * Math.max(0, clump(x) + 0.45 + 0.3 * Math.sin(x * 0.07)), "#a9cfb8", "#9cc6ac");
      for (const [shade, light, lift, size] of [["#b6d8c5", "#cce5d5", 0.007, 1.25], ["#8fbda1", "#acd2b6", 0, 0.9]] as const) {
        const crowns = new Path2D(), tops = new Path2D(), base = horizon + 2 - depth * lift;
        for (let x = -20; x < width + 20;) {
          const c = clump(x);
          if (c < -0.3) { x += 18 + random() * 30; continue; }
          const h = depth * (0.016 + 0.05 * (c + 0.3) * (0.4 + random() * 0.6)) * size;
          for (let k = 0; k < 4; k++) {
            const r = h * (0.3 + random() * 0.22), cx = x + (random() - 0.5) * h * 0.7, cy = base - h + r + random() * h * 0.45;
            crowns.moveTo(cx + r, cy); crowns.arc(cx, cy, r, 0, Math.PI * 2);
            tops.moveTo(cx + r * 0.4, cy - r * 0.3); tops.arc(cx - r * 0.2, cy - r * 0.3, r * 0.6, 0, Math.PI * 2);
          }
          crowns.rect(x - h * 0.35, base - h * 0.5, h * 0.7, h * 0.5);
          x += h * (0.45 + random() * 0.5);
        }
        b.fillStyle = shade; b.fill(crowns);
        b.globalAlpha = 0.5; b.fillStyle = light; b.fill(tops); b.globalAlpha = 1;
      }
      const ground = b.createLinearGradient(0, horizon, 0, height);
      for (const [stop, color, mist] of [[0, [120, 178, 110], 0.7], [0.15, [92, 164, 88], 0.42], [0.35, [40, 120, 58], 0.15], [0.62, [16, 86, 42], 0], [1, [6, 50, 30], 0]] as const)
        ground.addColorStop(stop, css(blend(color, haze, mist)));
      b.fillStyle = ground; b.fillRect(0, horizon - 1, width, height - horizon + 1);
      // The far field is painted once: fine blades in eight depth bins, three varieties, two tones.
      const paths = Array.from({ length: 48 }, () => new Path2D()), dots = blooms.map(() => new Path2D());
      for (let t = 0.004; t < edges[0]!;) {
        const s = scaleAt(t), h = tallest * s, y = horizon + depth * t, step = Math.max(2, h * 0.05);
        for (let x = random() * step; x < width; x += step * (0.5 + random())) {
          const bh = h * (0.55 + random() * 0.6), bw = Math.max(0.45, widest * s * (0.6 + random() * 0.8)), tilt = (random() - 0.4) * 0.5;
          const bin = Math.min(7, Math.floor((t / edges[0]!) * 8));
          const path = paths[(bin * 3 + patch(x, t, s, random)) * 2 + (random() > 0.5 ? 1 : 0)]!;
          path.moveTo(x - bw, y); path.lineTo(x + tilt * bh, y - bh); path.lineTo(x + bw, y);
          if (random() < 0.01) { const r = Math.max(0.6, 5 * s); const dot = dots[Math.floor(random() * 3)]!; dot.moveTo(x + tilt * bh + r, y - bh); dot.arc(x + tilt * bh, y - bh, r, 0, Math.PI * 2); }
        }
        t += Math.max(1.4, h * 0.12) / depth;
      }
      paths.forEach((path, i) => {
        const bin = Math.floor(i / 6), kind = kinds[Math.floor(i / 2) % 3]!, t = ((bin + 0.5) / 8) * edges[0]!;
        b.fillStyle = css(blend(blend(kind.base, kind.tip, i % 2 ? 0.85 : 0.5), haze, hazeAt(t) * 0.95));
        b.fill(path);
      });
      dots.forEach((dot, i) => { b.fillStyle = blooms[i]![0]; b.globalAlpha = 0.8; b.fill(dot); });
      b.globalAlpha = 1;
    }

    function build() {
      const rect = canvas!.getBoundingClientRect();
      if (Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 60) return;
      width = rect.width; height = rect.height;
      horizon = height * (parseFloat(getComputedStyle(canvas!).getPropertyValue("--horizon")) || 50) / 100;
      depth = height - horizon; tallest = depth * 0.62; widest = Math.min(4, 2 + width / 900);
      dpr = Math.min(devicePixelRatio || 1, width > 1100 ? 1.5 : 2);
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const random = seeded(7);
      paintBackdrop(random);
      bands = edges.slice(0, -1).map((top, i) => {
        const bottom = edges[i + 1]!, mid = (top + bottom) / 2, mist = hazeAt(mid);
        const blades: Blade[] = [], flowers: Flower[] = [];
        for (let t = top; t < bottom;) {
          const s = scaleAt(t), h = tallest * s, y = horizon + depth * t, step = h * 0.05;
          for (let x = random() * step; x < width; x += step * (0.5 + random())) {
            const blade: Blade = {
              x, y: y + random() * 4, t, h: h * (0.55 + random() * 0.6), w: widest * s * (0.6 + random() * 0.8) / 2,
              lean: (random() - 0.42) * 0.45, phase: random() * Math.PI * 2, bend: 0, kind: patch(x, t, s, random), odd: blades.length % 2 === 1,
              delay: 0.15 + (x / width) * 0.6 + random() * 0.25 + (1 - Math.min(t, 1)) * 0.25,
            };
            blades.push(blade);
            if (random() < 0.007) {
              const [color, eye] = blooms[random() < 0.3 ? 0 : random() < 0.55 ? 1 : 2]!;
              flowers.push({ blade, r: Math.max(1.4, 6.5 * s), color, eye });
            }
          }
          t += (h * 0.12) / depth;
        }
        const y0 = horizon + depth * bottom, y1 = horizon + depth * top - tallest * scaleAt(mid);
        const fills = kinds.flatMap(kind => {
          const base = blend(kind.base, haze, mist), tip = blend(kind.tip, haze, mist * 0.8), lit = blend(kind.lit, haze, mist * 0.6);
          return [[base, blend(base, tip, 0.6), tip], [base, tip, lit], [blend(base, tip, 0.5), lit, blend(lit, [255, 255, 240], 0.4)]].map(stops => {
            const gradient = ctx!.createLinearGradient(0, y0, 0, y1);
            stops.forEach((stop, k) => gradient.addColorStop(k / 2, css(stop)));
            return gradient;
          });
        });
        return { blades, flowers, fills };
      });
      shadow = ctx!.createRadialGradient(0, 0, 0, 0, 0, 1);
      shadow.addColorStop(0, "rgba(2,36,20,.26)"); shadow.addColorStop(0.55, "rgba(2,36,20,.13)"); shadow.addColorStop(1, "rgba(2,36,20,0)");
      if (!placed) {
        placed = true;
        for (const shade of shades) shade.x *= width;
        for (const fly of flies) { fly.x *= width; fly.y = horizon + depth * fly.y; }
      }
      if (still || !frame) draw(performance.now());
    }

    function draw(now: number) {
      const t = still ? 9 : (now - born) / 1000, time = still ? 0 : t;
      const dt = Math.min((now - (last || now)) / 1000, 0.05);
      last = now;
      const rise = still ? 0 : Math.pow(Math.min(1, Math.max(0, scrollY / height)), 1.4);
      if (!still) {
        nextGust -= dt;
        if (nextGust <= 0) { gusts.push({ x: -260, speed: 240 + Math.random() * 220, size: 150 + Math.random() * 170, power: 0.6 + Math.random() * 0.5 }); nextGust = 2.5 + Math.random() * 3.5; }
        for (const gust of gusts) gust.x += gust.speed * dt;
        while (gusts[0] && gusts[0].x > width + 520) gusts.shift();
        pointer.vx *= 0.9; pointer.speed *= 0.86;
      }
      ctx!.clearRect(0, 0, width, height);
      ctx!.globalAlpha = still ? 1 : ease(t / 0.9);
      ctx!.drawImage(backdrop, 0, 0, width, height);
      ctx!.globalAlpha = 1;
      // Gusts show as travelling sheen on the distant grass, where single blades are too small to read.
      ctx!.save();
      ctx!.beginPath(); ctx!.rect(0, horizon, width, depth); ctx!.clip();
      ctx!.globalCompositeOperation = "source-atop";
      for (const g of gusts) {
        const sheen = ctx!.createLinearGradient(g.x - g.size * 1.6, 0, g.x + g.size * 1.6, 0);
        sheen.addColorStop(0, "rgba(240,255,200,0)"); sheen.addColorStop(0.5, `rgba(240,255,200,${0.3 * g.power})`); sheen.addColorStop(1, "rgba(240,255,200,0)");
        ctx!.fillStyle = sheen; ctx!.fillRect(g.x - g.size * 1.6, horizon, g.size * 3.2, depth);
      }
      ctx!.restore();
      for (const { blades, flowers, fills } of bands) {
        const paths = fills.map(() => new Path2D());
        for (const blade of blades) {
          if (sparse && blade.odd) continue;
          const grow = ease((t - blade.delay) / 1.1);
          if (grow <= 0) continue;
          let gust = 0, push = 0;
          for (const g of gusts) gust += g.power * Math.exp(-(((blade.x - g.x) / g.size) ** 2));
          const reach = 30 + 150 * blade.t, dx = blade.x - pointer.x, dy = blade.y - blade.h * 0.6 - pointer.y;
          if (Math.abs(dx) < reach && Math.abs(dy) < blade.h + reach) {
            const force = 1 - Math.hypot(dx, dy * 0.6) / reach;
            if (force > 0) push = Math.sign(dx || 1) * force * force * 1.4 + pointer.vx * force * 0.004;
          }
          blade.bend += (push - blade.bend) * 0.14;
          const sway = Math.sin(time * 1.4 + blade.x * 0.012 + blade.phase) * 0.09 + Math.sin(time * 0.6 + blade.x * 0.003) * 0.06;
          const angle = blade.lean + sway + gust * 0.55 + blade.bend + rise * (blade.x / width - 0.5) * 0.8 * blade.t;
          const h = blade.h * grow * (1 + rise * blade.t * 1.8), w = blade.w;
          const tipX = blade.x + angle * h * 0.85, tipY = blade.y - h * (1 - Math.min(angle * angle * 0.22, 0.5));
          const cx = blade.x + angle * h * 0.18, cy = blade.y - h * 0.55;
          const path = paths[blade.kind * 3 + Math.min(2, Math.floor((gust * 0.8 + Math.abs(blade.bend) * 0.7) * 3))]!;
          path.moveTo(blade.x - w, blade.y);
          path.quadraticCurveTo(cx - w * 0.4, cy, tipX, tipY);
          path.quadraticCurveTo(cx + w * 0.4, cy, blade.x + w, blade.y);
          path.closePath();
        }
        paths.forEach((path, i) => { ctx!.fillStyle = fills[i]!; ctx!.fill(path); });
        for (const { blade, r, color, eye } of flowers) {
          const grow = ease((t - blade.delay - 0.35) / 1.1);
          if (grow <= 0) continue;
          const angle = blade.lean * 0.4 + Math.sin(time * 1.4 + blade.x * 0.012 + blade.phase) * 0.09 + blade.bend;
          const h = blade.h * 0.92 * grow * (1 + rise * blade.t * 1.8);
          const x = blade.x + angle * h * 0.85, y = blade.y - h * (1 - Math.min(angle * angle * 0.22, 0.5));
          ctx!.beginPath(); ctx!.arc(x, y, r * grow, 0, Math.PI * 2); ctx!.fillStyle = color; ctx!.fill();
          ctx!.beginPath(); ctx!.arc(x, y, r * 0.38 * grow, 0, Math.PI * 2); ctx!.fillStyle = eye; ctx!.fill();
        }
      }
      // Cloud shadows drift over everything already painted on the ground.
      ctx!.save();
      ctx!.globalCompositeOperation = "source-atop";
      ctx!.fillStyle = shadow!;
      for (const shade of shades) {
        const r = width * shade.size * 0.5;
        if (!still) { shade.x += shade.speed * dt; if (shade.x - r > width) shade.x = -r; }
        ctx!.setTransform(dpr * r, 0, 0, dpr * r * (0.22 + shade.t * 0.25), dpr * shade.x, dpr * (horizon + depth * shade.t));
        ctx!.fillRect(-1, -1, 2, 2);
      }
      ctx!.restore();
      if (!still) {
        for (const fly of flies) flutter(fly, time, dt);
        ctx!.fillStyle = "#fff6c4";
        for (const mote of motes) {
          mote.y -= mote.speed * dt * 0.1; if (mote.y < 0) mote.y = 1;
          ctx!.globalAlpha = Math.sin(mote.y * Math.PI) * 0.75 * ease(t - 1);
          ctx!.beginPath(); ctx!.arc((mote.x + Math.sin(time * 0.5 + mote.phase) * 0.01) * width, horizon - depth * 0.2 + mote.y * depth * 1.2, mote.size, 0, Math.PI * 2); ctx!.fill();
        }
        ctx!.globalAlpha = 1;
      }
      if (sound.engine && ++tick % 6 === 0) {
        let wind = 0;
        for (const g of gusts) wind += g.power * Math.exp(-(((width / 2 - g.x) / (width * 0.6)) ** 2));
        sound.engine.set(Math.min(1, wind), pointer.y > horizon - 40 ? Math.min(0.6, pointer.speed / 70) : 0);
      }
    }

    function flutter(fly: typeof flies[number], time: number, dt: number) {
      let goal = fly.heading + (Math.sin(time * 0.9 + fly.phase * 3) * 1.6 + Math.sin(time * 2.3 + fly.phase)) * dt * 2;
      const away = Math.hypot(fly.x - pointer.x, fly.y - pointer.y) < 130;
      if (away) goal = Math.atan2(fly.y - pointer.y, fly.x - pointer.x);
      else if (fly.x < 60) goal = 0;
      else if (fly.x > width - 60) goal = Math.PI;
      else if (fly.y < horizon + depth * 0.12) goal = Math.PI / 2;
      else if (fly.y > horizon + depth * 0.8) goal = -Math.PI / 2;
      const turn = Math.atan2(Math.sin(goal - fly.heading), Math.cos(goal - fly.heading));
      fly.heading += turn * Math.min(1, dt * (away ? 8 : 2.5));
      const speed = away ? 120 : 40;
      fly.x += Math.cos(fly.heading) * speed * dt;
      fly.y += Math.sin(fly.heading) * speed * dt * 0.6 + Math.sin(time * 6 + fly.phase) * 0.5;
      const size = 2.5 + 6 * Math.min(1, (fly.y - horizon) / depth), flap = 0.2 + 0.8 * Math.abs(Math.sin(time * 13 + fly.phase));
      ctx!.save();
      ctx!.translate(fly.x, fly.y); ctx!.rotate(Math.cos(fly.heading) > 0 ? 0.2 : -0.2);
      ctx!.fillStyle = fly.color;
      for (const side of [-1, 1]) { ctx!.beginPath(); ctx!.ellipse(side * size * 0.5 * flap, 0, size * 0.6 * flap + 0.4, size * 0.75, side * 0.5, 0, Math.PI * 2); ctx!.fill(); }
      ctx!.fillStyle = "#2b2a1a"; ctx!.fillRect(-0.6, -size * 0.5, 1.2, size);
      ctx!.restore();
    }

    function run(now: number) {
      const start = performance.now();
      draw(now);
      // Halve the animated blade count on devices that can't keep up.
      if (sampled < 90 && born && now - born > 1500) { cost += performance.now() - start; if (++sampled === 90) sparse = cost / 90 > 8; }
      frame = visible && !document.hidden ? requestAnimationFrame(run) : 0;
    }
    const wake = () => {
      if (!visible) sound.engine?.set(0.08, 0);
      if (!still && !frame && visible && !document.hidden) { last = 0; frame = requestAnimationFrame(run); }
    };
    const host = canvas.parentElement!;
    const move = (event: PointerEvent) => {
      if (still) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top;
      pointer.vx = Math.max(-40, Math.min(40, event.clientX - pointer.lastX));
      pointer.speed = Math.min(80, pointer.speed + Math.hypot(event.clientX - pointer.lastX, event.clientY - pointer.lastY) * 0.5);
      pointer.lastX = event.clientX; pointer.lastY = event.clientY;
    };
    const leave = () => { pointer.x = pointer.y = -1e4; };
    const resize = new ResizeObserver(build);
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; wake(); });
    born = performance.now();
    build();
    resize.observe(canvas); seen.observe(canvas);
    host.addEventListener("pointermove", move, { passive: true });
    host.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", wake);
    canvas.dataset.ready = "";
    wake();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); seen.disconnect();
      host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
