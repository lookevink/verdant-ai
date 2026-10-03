"use client";
import { forwardRef } from "react";

export type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "sad";

/**
 * The Verdant sprout with a face: the logo's stem and two leaves, grown from a seed-shaped head. The mood switches
 * poses through CSS; mouth opening follows `--mouth` (0–1), which the voice client sets on the element directly so
 * audio levels never re-render React.
 */
export const Sprout = forwardRef<HTMLDivElement, { mood: Mood; size?: number; label?: string }>(function Sprout({ mood, size = 168, label }, ref) {
  return <div ref={ref} className="sprout" data-mood={mood} style={{ width: size }} role="img" aria-label={label ?? `Sprout is ${mood}`}>
    <svg viewBox="0 0 200 220" aria-hidden="true">
      <defs>
        <radialGradient id="sprout-head" cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor="#e6fbb0" /><stop offset=".45" stopColor="#8fdc5c" /><stop offset="1" stopColor="#1da84a" />
        </radialGradient>
        <linearGradient id="sprout-leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c6f36b" /><stop offset="1" stopColor="#1da84a" /></linearGradient>
        <linearGradient id="sprout-leaf-r" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9be86a" /><stop offset="1" stopColor="#12813a" /></linearGradient>
      </defs>
      <ellipse className="sprout-shadow" cx="100" cy="209" rx="54" ry="7" />
      <path className="sprout-soil" d="M38 210c10-18 38-26 62-26s52 8 62 26Z" />
      <g className="sprout-body">
        <path className="sprout-stem" d="M100 204c0-14-1-26 0-40" />
        <g className="sprout-leaves">
          <path className="sprout-leaf sprout-leaf-l" d="M98 84C96 52 72 30 34 30c0 36 26 58 64 54Z" fill="url(#sprout-leaf)" />
          <path className="sprout-vein" d="M96 80C84 64 66 50 48 42" />
          <path className="sprout-leaf sprout-leaf-r" d="M102 80c4-32 28-52 66-50-2 34-28 54-66 50Z" fill="url(#sprout-leaf-r)" />
          <path className="sprout-vein" d="M104 76c12-16 30-30 50-38" />
        </g>
        <g className="sprout-head">
          <path d="M100 82c30 0 50 20 50 46 0 24-20 40-50 40s-50-16-50-40c0-26 20-46 50-46Z" fill="url(#sprout-head)" />
          <path className="sprout-gloss" d="M70 104c4-8 12-13 20-14" />
          <circle className="sprout-cheek" cx="70" cy="140" r="8" /><circle className="sprout-cheek" cx="130" cy="140" r="8" />
          <g className="sprout-eyes">
            <g className="sprout-eye"><ellipse cx="82" cy="124" rx="6.5" ry="8.5" /><circle className="sprout-glint" cx="84.5" cy="120.5" r="2.4" /></g>
            <g className="sprout-eye"><ellipse cx="118" cy="124" rx="6.5" ry="8.5" /><circle className="sprout-glint" cx="120.5" cy="120.5" r="2.4" /></g>
            <path className="sprout-happy-eye" d="M75 126q7-9 14 0M111 126q7-9 14 0" />
          </g>
          <path className="sprout-brow" d="M74 110q8-5 15-2M111 108q7-3 15 2" />
          <g className="sprout-mouth">
            <path className="sprout-smile" d="M90 143q10 9 20 0" />
            <ellipse className="sprout-open" cx="100" cy="146" rx="8" ry="7" />
          </g>
        </g>
      </g>
      <g className="sprout-thought" aria-hidden="true"><circle cx="160" cy="70" r="4" /><circle cx="172" cy="56" r="5.5" /><circle cx="186" cy="38" r="7" /></g>
    </svg>
  </div>;
});
