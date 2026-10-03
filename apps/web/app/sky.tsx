"use client";
import { useSyncExternalStore } from "react";
import { phases, type Phase } from "./phase";

const names: Record<Phase, string> = { dawn: "Dawn", day: "Midday", golden: "Golden hour", dusk: "Dusk" };
const listeners = new Set<() => void>();

export function readPhase(): Phase {
  const value = document.documentElement.dataset.phase as Phase | undefined;
  return value && phases.includes(value) ? value : "day";
}

export function onPhase(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function SkyToggle() {
  const phase = useSyncExternalStore(onPhase, readPhase, () => null);
  const next = phases[(phases.indexOf(phase ?? "day") + 1) % phases.length]!;
  function change() {
    document.documentElement.dataset.phase = next;
    listeners.forEach(listener => listener());
  }
  return <button type="button" className="pill" onClick={change} title="Follows your local time. Click to change it."
    aria-label={phase ? `Sky: ${names[phase]}. Switch to ${names[next]}` : "Change the time of day"}>
    <svg className="sky-icon" viewBox="0 0 20 20" aria-hidden="true">
      {phase === "dusk" ? <path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1Z" />
        : phase === "dawn" || phase === "golden" ? <path d="M5.5 14a4.5 4.5 0 0 1 9 0M2.5 14h15M10 4.5V7M4.6 7.6l1.6 1.4M15.4 7.6l-1.6 1.4" />
        : <><circle cx="10" cy="10" r="3.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></>}
    </svg>
    <span className="pill-label">{phase ? names[phase] : "Sky"}</span>
  </button>;
}
