"use client";
import { useEffect, useRef } from "react";

// Layers run far → near. Distant grass is paler and bluer (atmospheric perspective);
// near grass has cool, deep bases and warm, sunlit tips. Lit tones are what a gust reveals.
const layers = [
  { horizon: 0.16, hill: 10, height: [0.07, 0.12], density: 5.2, width: 1.6, ground: ["#b7e3b4", "#9fd6a2"], blade: ["#8ccb98", "#c9ecb0"], lit: ["#e6f8c8", "#f6fde6"] },
  { horizon: 0.36, hill: 16, height: [0.12, 0.2], density: 4.4, width: 2.4, ground: ["#6fca72", "#4fb562"], blade: ["#3f9f57", "#9fe07a"], lit: ["#d4f59a", "#effcc9"] },
  { horizon: 0.6, hill: 18, height: [0.2, 0.32], density: 3.8, width: 3.4, ground: ["#2fa44c", "#178a42"], blade: ["#0f7339", "#7fd85a"], lit: ["#c8f36b", "#ecfcb4"] },
  { horizon: 0.86, hill: 14, height: [0.3, 0.5], density: 3.1, width: 5, ground: ["#0f7a3c", "#063f25"], blade: ["#0a4f2c", "#5cc94a"], lit: ["#b8ee5a", "#e4fba0"] },
] as const;

type Blade = { x: number; y: number; h: number; w: number; lean: number; phase: number; bend: number; delay: number };
type Flower = { blade: Blade; r: number; poppy: boolean };

function seeded(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);

export function Field() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: -1e4, y: -1e4, vx: 0, lastX: 0 };
    const gusts: { x: number; speed: number; size: number; power: number }[] = [];
    const motes = Array.from({ length: 26 }, (_, i) => ({ x: Math.random(), y: Math.random(), size: 0.6 + Math.random() * 1.6, speed: 0.25 + Math.random() * 0.6, phase: i }));
    let field: { blades: Blade[]; flowers: Flower[]; hills: number[]; ground: CanvasGradient; fills: CanvasGradient[] }[] = [];
    let width = 0, height = 0, frame = 0, visible = true, born = 0, last = 0, nextGust = 1.4;

    const hillAt = (l: number, x: number) => {
      const layer = layers[l]!;
      return height * layer.horizon + Math.sin(x * 0.0042 + l * 1.7) * layer.hill + Math.sin(x * 0.011 + l * 4.1) * layer.hill * 0.45;
    };

    function build() {
      const rect = canvas!.getBoundingClientRect();
      if (Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 60) return;
      width = rect.width; height = rect.height;
      const dpr = Math.min(devicePixelRatio || 1, width > 1100 ? 1.5 : 2);
      canvas!.width = Math.round(width * dpr); canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const random = seeded(7);
      field = layers.map((layer, l) => {
        const blades: Blade[] = [], flowers: Flower[] = [], hills: number[] = [];
        const count = Math.round(width / layer.density);
        for (let i = 0; i < count; i++) {
          const x = (i + random()) * layer.density;
          blades.push({
            x, y: hillAt(l, x) + 2 + random() * 6, w: layer.width * (0.7 + random() * 0.6),
            h: height * (layer.height[0] + random() * (layer.height[1] - layer.height[0])),
            lean: (random() - 0.5) * 0.5, phase: random() * Math.PI * 2, bend: 0,
            delay: 0.1 + (x / width) * 0.7 + random() * 0.3 + (3 - l) * 0.05,
          });
        }
        if (l >= 2) for (let i = 0; i < width / (l === 2 ? 70 : 110); i++)
          flowers.push({ blade: blades[Math.floor(random() * blades.length)]!, r: (l === 2 ? 2.6 : 4) * (0.8 + random() * 0.4), poppy: random() > 0.58 });
        for (let x = 0; x <= width + 24; x += 24) hills.push(hillAt(l, x));
        const ground = ctx!.createLinearGradient(0, height * layer.horizon - layer.hill * 1.5, 0, height);
        ground.addColorStop(0, layer.ground[0]); ground.addColorStop(1, layer.ground[1]);
        const stops = [[layer.blade[0], layer.blade[1], layer.blade[1]], [layer.blade[0], layer.blade[1], layer.lit[0]], [layer.blade[1], layer.lit[0], layer.lit[1]]];
        const fills = stops.map(([base, mid, tip]) => {
          const gradient = ctx!.createLinearGradient(0, height * layer.horizon + layer.hill, 0, height * (layer.horizon - layer.height[1]));
          gradient.addColorStop(0, base!); gradient.addColorStop(0.55, mid!); gradient.addColorStop(1, tip!);
          return gradient;
        });
        return { blades, flowers, hills, ground, fills };
      });
      if (still || !frame) draw(performance.now());
    }

    function shape(blade: Blade, lean: number, h: number) {
      return [blade.x + lean * h * 0.85, blade.y - h * (1 - Math.min(lean * lean * 0.22, 0.5))] as const;
    }

    function draw(now: number) {
      const t = still ? 9 : (now - born) / 1000, time = still ? 0 : t;
      const dt = Math.min((now - (last || now)) / 1000, 0.05);
      last = now;
      if (!still) {
        nextGust -= dt;
        if (nextGust <= 0) { gusts.push({ x: -240, speed: 260 + Math.random() * 220, size: 140 + Math.random() * 160, power: 0.6 + Math.random() * 0.5 }); nextGust = 2.5 + Math.random() * 3.5; }
        for (const gust of gusts) gust.x += gust.speed * dt;
        while (gusts[0] && gusts[0].x > width + 480) gusts.shift();
        pointer.vx *= 0.9;
      }
      ctx!.clearRect(0, 0, width, height);
      field.forEach(({ blades, flowers, hills, ground, fills }, l) => {
        ctx!.beginPath(); ctx!.moveTo(0, height);
        hills.forEach((y, i) => ctx!.lineTo(i * 24, y));
        ctx!.lineTo(width, height); ctx!.fillStyle = ground; ctx!.fill();
        const paths = [new Path2D(), new Path2D(), new Path2D()];
        const reach = 150 * (0.4 + l * 0.2);
        for (const blade of blades) {
          const grow = ease((t - blade.delay) / 1.1);
          if (grow <= 0) continue;
          let gust = 0, push = 0;
          for (const g of gusts) gust += g.power * Math.exp(-(((blade.x - g.x) / g.size) ** 2));
          const dx = blade.x - pointer.x, dy = blade.y - blade.h * 0.6 - pointer.y;
          if (Math.abs(dx) < reach && Math.abs(dy) < blade.h + reach) {
            const force = 1 - Math.hypot(dx, dy * 0.6) / reach;
            if (force > 0) push = Math.sign(dx || 1) * force * force * 1.4 + pointer.vx * force * 0.004;
          }
          blade.bend += (push - blade.bend) * 0.14;
          const sway = Math.sin(time * 1.4 + blade.x * 0.012 + blade.phase) * 0.09 + Math.sin(time * 0.6 + blade.x * 0.003) * 0.06;
          const lean = blade.lean + sway + gust * 0.55 + blade.bend, h = blade.h * grow, w = blade.w / 2;
          const [tipX, tipY] = shape(blade, lean, h);
          const cx = blade.x + lean * h * 0.18, cy = blade.y - h * 0.55;
          const path = paths[Math.min(2, Math.floor((gust * 0.8 + Math.abs(blade.bend) * 0.7) * 3))]!;
          path.moveTo(blade.x - w, blade.y);
          path.quadraticCurveTo(cx - w * 0.4, cy, tipX, tipY);
          path.quadraticCurveTo(cx + w * 0.4, cy, blade.x + w, blade.y);
          path.closePath();
        }
        paths.forEach((path, i) => { ctx!.fillStyle = fills[i]!; ctx!.fill(path); });
        for (const { blade, r, poppy } of flowers) {
          const grow = ease((t - blade.delay - 0.35) / 1.1);
          if (grow <= 0) continue;
          const lean = blade.lean * 0.4 + Math.sin(time * 1.4 + blade.x * 0.012 + blade.phase) * 0.09 + blade.bend;
          const [x, y] = shape(blade, lean, blade.h * 0.92 * grow);
          ctx!.beginPath(); ctx!.arc(x, y, r * grow, 0, Math.PI * 2);
          ctx!.fillStyle = poppy ? "#ff5b3a" : "#ffcf33"; ctx!.fill();
          ctx!.beginPath(); ctx!.arc(x, y, r * 0.38 * grow, 0, Math.PI * 2);
          ctx!.fillStyle = poppy ? "#3a1a10" : "#f59e0b"; ctx!.fill();
        }
      });
      if (!still) {
        ctx!.fillStyle = "#fff6c4";
        for (const mote of motes) {
          mote.y -= mote.speed * dt * 0.1; if (mote.y < 0) mote.y = 1;
          ctx!.globalAlpha = Math.sin(mote.y * Math.PI) * 0.75 * ease(t - 1);
          ctx!.beginPath(); ctx!.arc((mote.x + Math.sin(time * 0.5 + mote.phase) * 0.01) * width, mote.y * height, mote.size, 0, Math.PI * 2); ctx!.fill();
        }
        ctx!.globalAlpha = 1;
      }
    }

    function loop(now: number) {
      draw(now);
      frame = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
    }
    const wake = () => { if (!still && !frame && visible && !document.hidden) { last = 0; frame = requestAnimationFrame(loop); } };
    const host = canvas.parentElement!;
    const move = (event: PointerEvent) => {
      if (still) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left; pointer.y = event.clientY - rect.top;
      pointer.vx = Math.max(-40, Math.min(40, event.clientX - pointer.lastX)); pointer.lastX = event.clientX;
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
