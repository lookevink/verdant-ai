"use client";
import { useEffect, useRef } from "react";
import type { Phase } from "./phase";
import { onPhase, readPhase } from "./sky";
import { sound } from "./sound";

type RGB = readonly [number, number, number];
type Blade = { x: number; y: number; t: number; h: number; w: number; lean: number; phase: number; bend: number; delay: number; kind: number; odd: boolean; dither: number };
type Flower = { blade: Blade; r: number; color: string; eye: string };
type Band = { blades: Blade[]; flowers: Flower[]; fills: CanvasGradient[] };
type Grade = { haze: RGB; tint: RGB; k: number; dim: number; glow: RGB; glowK: number; sheen: string; sheenAlpha: number; mist: number; shade: number; night: boolean; mote: string };

// Depth t runs from 0 at the horizon to 1 at the bottom edge. On flat ground apparent size grows
// linearly with t, so blades shrink into a fine texture toward the horizon. Distance fades into the
// sky's haze (aerial perspective); tips warm toward sunlight, bases cool into shade, and the three
// grass varieties cluster into patches the way a real meadow does.
const kinds: { base: RGB; tip: RGB; lit: RGB }[] = [
  { base: [9, 70, 38], tip: [112, 204, 78], lit: [208, 244, 128] },
  { base: [52, 88, 24], tip: [190, 214, 92], lit: [244, 246, 170] },
  { base: [5, 60, 46], tip: [78, 182, 120], lit: [182, 236, 184] },
];
const blooms: [RGB, RGB][] = [[[255, 91, 58], [58, 26, 16]], [[255, 207, 51], [245, 158, 11]], [[251, 251, 240], [255, 207, 51]]];
// Each time of day regrades the same meadow: its haze, a light tint, overall brightness and the colour gusts reveal.
const grades: Record<Phase, Grade> = {
  dawn: { haze: [238, 224, 228], tint: [255, 190, 175], k: 0.1, dim: 0.88, glow: [255, 230, 214], glowK: 0.35, sheen: "255,238,232", sheenAlpha: 0.25, mist: 0.6, shade: 0.5, night: false, mote: "#fff1ea" },
  day: { haze: [216, 236, 222], tint: [255, 255, 255], k: 0, dim: 1, glow: [255, 255, 240], glowK: 0, sheen: "240,255,200", sheenAlpha: 0.3, mist: 0, shade: 1, night: false, mote: "#fff6c4" },
  golden: { haze: [246, 224, 178], tint: [255, 168, 60], k: 0.16, dim: 0.96, glow: [255, 210, 110], glowK: 0.5, sheen: "255,222,150", sheenAlpha: 0.34, mist: 0.2, shade: 0.8, night: false, mote: "#ffd98a" },
  dusk: { haze: [38, 66, 78], tint: [22, 42, 74], k: 0.42, dim: 0.42, glow: [160, 214, 204], glowK: 0.45, sheen: "150,210,200", sheenAlpha: 0.12, mist: 0.35, shade: 0, night: true, mote: "#d8ff8a" },
};
// Animated depth bands. The painted far field hands over to them across the seam ± overlap,
// so no row of blade bases lines up into a visible edge.
const edges = [0.3, 0.42, 0.54, 0.66, 0.78, 0.9, 1.15];
const seam = edges[0]!, overlap = 0.07, far = seam + overlap;
const blend = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const css = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const hazeAt = (t: number) => Math.pow(1 - Math.min(t, 1), 3) * 0.9;
const scaleAt = (t: number) => Math.max(0.012, Math.pow(t, 1.1));
const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);
const handover = (t: number) => { const k = Math.min(Math.max((t - seam + overlap) / (2 * overlap), 0), 1); return k * k * (3 - 2 * k); };
function seeded(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function Field() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const backdrop = document.createElement("canvas"), glow = document.createElement("canvas");
    const pointer = { x: -1e4, y: -1e4, vx: 0, speed: 0, lastX: 0, lastY: 0 };
    const gusts: { x: number; speed: number; size: number; power: number }[] = [];
    const ripples: { x: number; y: number; born: number }[] = [];
    const sparks: { x: number; y: number; vx: number; vy: number; born: number; size: number; petal: boolean }[] = [];
    const shades = [{ x: 0.15, t: 0.55, size: 0.55, speed: 16 }, { x: 0.8, t: 0.28, size: 0.42, speed: 11 }];
    const flies = [{ x: 0.3, y: 0.42, heading: 0.4, phase: 0, color: [255, 251, 232] as RGB }, { x: 0.72, y: 0.6, heading: 2.8, phase: 2.4, color: [255, 230, 128] as RGB }];
    const motes = Array.from({ length: 28 }, (_, i) => ({ x: Math.random(), y: Math.random(), size: 0.6 + Math.random() * 1.6, speed: 0.25 + Math.random() * 0.6, phase: i }));
    const fireflies = Array.from({ length: 44 }, () => ({ x: Math.random(), t: 0.06 + Math.random() * 0.85, lift: 0.3 + Math.random() * 0.5, phase: Math.random() * 6.3, speed: 0.4 + Math.random() * 0.6 }));
    let grade = grades[readPhase()], bands: Band[] = [], shadow: CanvasGradient | null = null, glint: CanvasGradient | null = null, fade: HTMLCanvasElement | null = null;
    let width = 0, height = 0, horizon = 0, depth = 0, tallest = 0, widest = 0, dpr = 1, fadeStart = 0;
    let frame = 0, visible = true, born = 0, last = 0, nextGust = 1.2, sampled = 0, cost = 0, sparse = false, placed = false, tick = 0;

    glow.width = glow.height = 64;
    const halo = glow.getContext("2d")!, light = halo.createRadialGradient(32, 32, 0, 32, 32, 32);
    light.addColorStop(0, "rgba(246,255,200,1)"); light.addColorStop(0.18, "rgba(214,250,140,.85)"); light.addColorStop(0.45, "rgba(198,243,107,.25)"); light.addColorStop(1, "rgba(198,243,107,0)");
    halo.fillStyle = light; halo.fillRect(0, 0, 64, 64);

    const graded = (c: RGB): RGB => { const m = blend(c, grade.tint, grade.k); return [m[0] * grade.dim, m[1] * grade.dim, m[2] * grade.dim]; };
    const tone = (c: RGB, mist: number) => css(blend(graded(c), grade.haze, mist));

    function patch(x: number, t: number, s: number, random: () => number) {
      const gx = (x - width / 2) / Math.max(s, 0.05), gz = 1 / Math.max(t, 0.02);
      const n = Math.sin(gx * 0.0035 + gz * 0.8) * 0.6 + Math.sin(gx * 0.0011 - gz * 1.9 + 1.3) * 0.4 + (random() - 0.5) * 0.9;
      return n > 0.42 ? 1 : n < -0.5 ? 2 : 0;
    }

    function paintBackdrop(random: () => number, palette: { base: RGB; tip: RGB }[]) {
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
      ridge(x => horizon - depth * (0.075 + 0.045 * Math.sin(x * 0.0021 + 1) + 0.02 * Math.sin(x * 0.0067 + 4)), tone([120, 170, 150], 0.8), tone([110, 160, 140], 0.76));
      // A hazy treeline: irregular clumps of overlapping crowns with sunlit tops, paler in the back row.
      const clump = (x: number) => (Math.sin(x * 0.009 + 1) + Math.sin(x * 0.023 + 3) * 0.6 + Math.sin(x * 0.0041) * 0.8) / 2.4;
      ridge(x => horizon - depth * 0.009 * Math.max(0, clump(x) + 0.45 + 0.3 * Math.sin(x * 0.07)), tone([70, 130, 90], 0.68), tone([60, 120, 80], 0.64));
      for (const [green, mist, size] of [[[80, 140, 100], 0.75, 1.25], [[46, 104, 66], 0.57, 0.9]] as const) {
        const crowns = new Path2D(), tops = new Path2D(), lift = size > 1 ? 0.007 : 0, base = horizon + 2 - depth * lift;
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
        b.fillStyle = tone(green, mist); b.fill(crowns);
        b.globalAlpha = 0.5; b.fillStyle = tone(blend(green, grade.glowK ? grade.glow : [255, 255, 230], 0.35), mist - 0.05); b.fill(tops); b.globalAlpha = 1;
      }
      const ground = b.createLinearGradient(0, horizon, 0, height);
      for (const [stop, color, mist] of [[0, [120, 178, 110], 0.7], [0.15, [92, 164, 88], 0.42], [0.35, [40, 120, 58], 0.15], [0.62, [16, 86, 42], 0], [1, [6, 50, 30], 0]] as const)
        ground.addColorStop(stop, tone(color, mist));
      b.fillStyle = ground; b.fillRect(0, horizon - 1, width, height - horizon + 1);
      // The far field is painted once: fine blades in eight depth bins, three varieties, two tones.
      const paths = Array.from({ length: 48 }, () => new Path2D()), dots = blooms.map(() => new Path2D());
      for (let t = 0.004; t < far;) {
        const s = scaleAt(t), h = tallest * s, y = horizon + depth * t, step = Math.max(2, h * 0.05);
        for (let x = random() * step; x < width; x += step * (0.5 + random())) {
          if (random() < handover(t)) continue;
          const bh = h * (0.55 + random() * 0.6), bw = Math.max(0.45, widest * s * (0.6 + random() * 0.8)), tilt = (random() - 0.4) * 0.5;
          const bin = Math.min(7, Math.max(0, Math.floor((t / far + (random() - 0.5) / 8) * 8)));
          const path = paths[(bin * 3 + patch(x, t, s, random)) * 2 + (random() > 0.5 ? 1 : 0)]!;
          path.moveTo(x - bw, y); path.lineTo(x + tilt * bh, y - bh); path.lineTo(x + bw, y);
          if (random() < 0.01) { const r = Math.max(0.6, 5 * s); const dot = dots[Math.floor(random() * 3)]!; dot.moveTo(x + tilt * bh + r, y - bh); dot.arc(x + tilt * bh, y - bh, r, 0, Math.PI * 2); }
        }
        t += Math.max(1.4, h * 0.12) / depth;
      }
      paths.forEach((path, i) => {
        const bin = Math.floor(i / 6), kind = palette[Math.floor(i / 2) % 3]!, t = ((bin + 0.5) / 8) * far;
        b.fillStyle = css(blend(blend(kind.base, kind.tip, i % 2 ? 0.85 : 0.5), grade.haze, hazeAt(t)));
        b.fill(path);
      });
      dots.forEach((dot, i) => { b.fillStyle = css(graded(blooms[i]![0])); b.globalAlpha = 0.8; b.fill(dot); });
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
      const palette = kinds.map(kind => ({ base: graded(kind.base), tip: blend(graded(kind.tip), grade.glow, grade.glowK * 0.3), lit: blend(graded(kind.lit), grade.glow, grade.glowK) }));
      paintBackdrop(random, palette);
      bands = edges.slice(0, -1).map((edge, i) => {
        const top = i ? edge : seam - overlap, bottom = edges[i + 1]!, mid = (edge + bottom) / 2, mist = hazeAt(mid);
        // Distant blades show only their tops, so bases lighten toward the far field and meet its tone.
        const lift = Math.min(Math.max((0.55 - mid) / 0.25, 0), 1);
        const y0 = horizon + depth * (bottom + 0.04), y1 = horizon + depth * (top - 0.04) - tallest * scaleAt(mid);
        const fills = palette.flatMap(kind => {
          const base = blend(blend(kind.base, blend(kind.base, kind.tip, 0.55), lift), grade.haze, mist), tip = blend(kind.tip, grade.haze, mist * 0.8), lit = blend(kind.lit, grade.haze, mist * 0.6);
          return [[base, blend(base, tip, 0.6), tip], [base, tip, lit], [blend(base, tip, 0.5), lit, blend(lit, [255, 255, 240], grade.night ? 0.15 : 0.4)]].map(stops => {
            const gradient = ctx!.createLinearGradient(0, y0, 0, y1);
            stops.forEach((stop, k) => gradient.addColorStop(k / 2, css(stop)));
            return gradient;
          });
        });
        return { blades: [], flowers: [], fills };
      });
      // Band membership is jittered so colour steps between bands dissolve instead of forming lines.
      let count = 0;
      for (let t = seam - overlap; t < edges.at(-1)!;) {
        const s = scaleAt(t), h = tallest * s, y = horizon + depth * t, step = h * 0.05;
        for (let x = random() * step; x < width; x += step * (0.5 + random())) {
          if (random() > handover(t)) continue;
          const jittered = t + (random() - 0.5) * 0.08;
          const band = bands[Math.max(0, edges.findIndex((edge, i) => i === edges.length - 2 || jittered < edges[i + 1]!))]!;
          const blade: Blade = {
            x, y: y + random() * 4, t, h: h * (0.55 + random() * 0.6), w: widest * s * (0.6 + random() * 0.8) / 2,
            lean: (random() - 0.42) * 0.45, phase: random() * Math.PI * 2, bend: 0, kind: patch(x, t, s, random), odd: count++ % 2 === 1, dither: random() - 0.5,
            delay: 0.15 + (x / width) * 0.6 + random() * 0.25 + (1 - Math.min(t, 1)) * 0.25,
          };
          band.blades.push(blade);
          if (random() < 0.007) {
            const [petal, eye] = blooms[random() < 0.3 ? 0 : random() < 0.55 ? 1 : 2]!;
            band.flowers.push({ blade, r: Math.max(1.4, 6.5 * s), color: css(graded(petal)), eye: css(graded(eye)) });
          }
        }
        t += (h * 0.12) / depth;
      }
      shadow = ctx!.createRadialGradient(0, 0, 0, 0, 0, 1);
      shadow.addColorStop(0, `rgba(2,36,20,${0.26 * grade.shade})`); shadow.addColorStop(0.55, `rgba(2,36,20,${0.13 * grade.shade})`); shadow.addColorStop(1, "rgba(2,36,20,0)");
      glint = ctx!.createRadialGradient(0, 0, 0, 0, 0, 1);
      glint.addColorStop(0, `rgba(${grade.sheen},${grade.sheenAlpha * 1.1})`); glint.addColorStop(0.45, `rgba(${grade.sheen},${grade.sheenAlpha * 0.5})`); glint.addColorStop(1, `rgba(${grade.sheen},0)`);
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
        while (ripples[0] && now - ripples[0].born > 1600) ripples.shift();
        pointer.vx *= 0.9; pointer.speed *= 0.86;
      }
      const rings = ripples.map(r => ({ x: r.x, y: r.y, radius: ((now - r.born) / 1000) * 620, power: 1 - (now - r.born) / 1600 }));
      ctx!.clearRect(0, 0, width, height);
      ctx!.globalAlpha = still ? 1 : ease(t / 0.9);
      ctx!.drawImage(backdrop, 0, 0, width, height);
      ctx!.globalAlpha = 1;
      // Gusts show as a soft travelling sheen on the distant grass, where single blades are too small to read.
      ctx!.save();
      ctx!.globalCompositeOperation = "source-atop";
      ctx!.fillStyle = glint!;
      for (const g of gusts) {
        ctx!.globalAlpha = Math.min(1, g.power);
        ctx!.setTransform(dpr * g.size * 1.8, 0, 0, dpr * depth * 0.24, dpr * g.x, dpr * (horizon + depth * 0.17));
        ctx!.fillRect(-1, -1, 2, 2);
      }
      ctx!.restore();
      if (grade.mist) {
        const fog = ctx!.createLinearGradient(0, horizon - depth * 0.06, 0, horizon + depth * 0.24), color = blend(grade.haze, [255, 255, 255], grade.night ? 0.1 : 0.35);
        fog.addColorStop(0, rgba(color, 0)); fog.addColorStop(0.3, rgba(color, grade.mist * 0.8)); fog.addColorStop(1, rgba(color, 0));
        ctx!.fillStyle = fog; ctx!.fillRect(0, horizon - depth * 0.06, width, depth * 0.3);
      }
      for (const { blades, flowers, fills } of bands) {
        const paths = fills.map(() => new Path2D());
        for (const blade of blades) {
          if (sparse && blade.odd) continue;
          const grow = ease((t - blade.delay) / 1.1);
          if (grow <= 0) continue;
          let gust = 0, push = 0, wave = 0;
          for (const g of gusts) gust += g.power * Math.exp(-(((blade.x - g.x) / g.size) ** 2));
          for (const ring of rings) {
            const dx = blade.x - ring.x, d = Math.hypot(dx, (blade.y - ring.y) * 2.2);
            const hit = Math.exp(-(((d - ring.radius) / 70) ** 2)) * ring.power;
            push += Math.sign(dx || 1) * hit * 1.3; wave += hit;
          }
          const reach = 30 + 150 * blade.t, dx = blade.x - pointer.x, dy = blade.y - blade.h * 0.6 - pointer.y;
          if (Math.abs(dx) < reach && Math.abs(dy) < blade.h + reach) {
            const force = 1 - Math.hypot(dx, dy * 0.6) / reach;
            if (force > 0) push += Math.sign(dx || 1) * force * force * 1.4 + pointer.vx * force * 0.004;
          }
          blade.bend += (push - blade.bend) * 0.14;
          const sway = Math.sin(time * 1.4 + blade.x * 0.012 + blade.phase) * 0.09 + Math.sin(time * 0.6 + blade.x * 0.003) * 0.06;
          const angle = blade.lean + sway + gust * 0.55 + blade.bend + rise * (blade.x / width - 0.5) * 0.8 * blade.t;
          const h = blade.h * grow * (1 + rise * blade.t * 1.8), w = blade.w;
          const tipX = blade.x + angle * h * 0.85, tipY = blade.y - h * (1 - Math.min(angle * angle * 0.22, 0.5));
          const cx = blade.x + angle * h * 0.18, cy = blade.y - h * 0.55;
          // Dithering the light level per blade feathers the edges of lit patches.
          const path = paths[blade.kind * 3 + Math.min(2, Math.max(0, Math.floor((gust * 0.8 + Math.abs(blade.bend) * 0.7 + wave * 0.8) * 3 + blade.dither * 0.9)))]!;
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
      if (grade.shade) {
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
      }
      if (grade.night) {
        ctx!.globalCompositeOperation = "lighter";
        for (const fly of fireflies) {
          const blink = Math.max(0, Math.sin((still ? 1 : time) * 1.3 * fly.speed + fly.phase));
          if (blink < 0.05) continue;
          const t2 = fly.t + Math.sin(time * 0.3 * fly.speed + fly.phase * 2) * 0.03, s = 4 + 16 * scaleAt(t2);
          const x = (fly.x + Math.sin(time * 0.17 * fly.speed + fly.phase) * 0.04) * width, y = horizon + depth * t2 - tallest * scaleAt(t2) * fly.lift;
          ctx!.globalAlpha = blink * blink * (0.5 + 0.5 * t2);
          ctx!.drawImage(glow, x - s, y - s, s * 2, s * 2);
        }
        ctx!.globalCompositeOperation = "source-over"; ctx!.globalAlpha = 1;
      }
      if (!still) {
        if (!grade.night) for (const fly of flies) flutter(fly, time, dt);
        for (const spark of sparks) {
          const age = (now - spark.born) / 1000;
          if (age > 1.8) continue;
          spark.vy += 150 * dt; spark.vx *= 0.985; spark.vy *= 0.985;
          spark.x += spark.vx * dt + Math.sin(age * 5 + spark.size * 9) * 0.4; spark.y += spark.vy * dt;
          ctx!.globalAlpha = 1 - age / 1.8;
          if (grade.night) { ctx!.globalCompositeOperation = "lighter"; ctx!.drawImage(glow, spark.x - 9, spark.y - 9, 18, 18); ctx!.globalCompositeOperation = "source-over"; }
          else {
            ctx!.beginPath();
            if (spark.petal) ctx!.ellipse(spark.x, spark.y, spark.size * 1.7, spark.size * 0.8, age * 7 + spark.size, 0, Math.PI * 2);
            else ctx!.arc(spark.x, spark.y, spark.size, 0, Math.PI * 2);
            ctx!.fillStyle = spark.petal ? css(graded(blooms[0]![0])) : grade.mote; ctx!.fill();
          }
        }
        while (sparks[0] && now - sparks[0].born > 1800) sparks.shift();
        if (!grade.night) {
          ctx!.fillStyle = grade.mote;
          for (const mote of motes) {
            mote.y -= mote.speed * dt * 0.1; if (mote.y < 0) mote.y = 1;
            ctx!.globalAlpha = Math.sin(mote.y * Math.PI) * 0.75 * ease(t - 1);
            ctx!.beginPath(); ctx!.arc((mote.x + Math.sin(time * 0.5 + mote.phase) * 0.01) * width, horizon - depth * 0.2 + mote.y * depth * 1.2, mote.size, 0, Math.PI * 2); ctx!.fill();
          }
        }
        ctx!.globalAlpha = 1;
      }
      // Crossfade from the previous time of day.
      if (fade) {
        const k = 1 - (now - fadeStart) / 1200;
        if (k <= 0) fade = null;
        else { ctx!.globalAlpha = k; ctx!.drawImage(fade, 0, 0, width, height); ctx!.globalAlpha = 1; }
      }
      if (sound.engine && ++tick % 6 === 0) {
        let wind = 0, swell = 0;
        for (const g of gusts) wind += g.power * Math.exp(-(((width / 2 - g.x) / (width * 0.6)) ** 2));
        for (const ring of rings) swell += Math.max(0, ring.power);
        sound.engine.set(Math.min(1, wind + swell * 0.9), Math.min(0.6, (pointer.y > horizon - 40 ? pointer.speed / 70 : 0) + swell * 0.35));
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
      ctx!.fillStyle = css(graded(fly.color));
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
    // Clicking the meadow sends a ring of wind outward and throws up pollen, petals or fireflies.
    const tap = (event: MouseEvent) => {
      if (still || (event.target as Element).closest("a, button, input, select, textarea, label")) return;
      const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (y < horizon - 30) return;
      const now = performance.now();
      ripples.push({ x, y: Math.max(y, horizon + depth * 0.04), born: now });
      for (let i = 0; i < 28; i++) sparks.push({ x, y: y - 8, vx: (Math.random() - 0.5) * 260, vy: -(80 + Math.random() * 260), born: now, size: 1 + Math.random() * 2.2, petal: Math.random() < 0.18 });
      if (sparks.length > 240) sparks.splice(0, sparks.length - 240);
      host.dataset.touched = "";
      wake();
    };
    const regrade = () => {
      if (!still && width) {
        fade = document.createElement("canvas");
        fade.width = canvas.width; fade.height = canvas.height;
        fade.getContext("2d")!.drawImage(canvas, 0, 0);
        fadeStart = performance.now();
      }
      grade = grades[readPhase()];
      width = 0; build(); wake();
    };
    const resize = new ResizeObserver(build);
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; wake(); });
    const off = onPhase(regrade);
    born = performance.now();
    build();
    resize.observe(canvas); seen.observe(canvas);
    host.addEventListener("pointermove", move, { passive: true });
    host.addEventListener("pointerleave", leave);
    host.addEventListener("click", tap);
    document.addEventListener("visibilitychange", wake);
    canvas.dataset.ready = "";
    wake();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); seen.disconnect(); off();
      host.removeEventListener("pointermove", move); host.removeEventListener("pointerleave", leave); host.removeEventListener("click", tap);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  return <canvas ref={ref} className="field" aria-hidden="true" />;
}
