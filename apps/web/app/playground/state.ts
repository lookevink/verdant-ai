import type { PlaygroundChart, PlaygroundDataset, PlaygroundEvent, PlaygroundReport, PlaygroundUsage } from "@verdant/contracts/playground";

export type Step = { id: string; parent?: string; tool: string; label: string; input?: string; summary?: string; status: "running" | "done" | "failed"; children: string[] };
/** Root-level work in order: the analyst's notes between tool calls, and tool steps (with nested calls as children). */
export type Entry = { type: "note"; text: string } | { type: "step"; id: string };
export type Turn = {
  seq: number; text: string; source: "text" | "voice"; status: "queued" | "running" | "done" | "failed" | "cancelled";
  timeline: Entry[]; draft: string; steps: Record<string, Step>; reply?: string; reason?: string; usage?: PlaygroundUsage;
  durationMs?: number; startedAt?: number; finishedAt?: number; artifacts: string[];
};
export type View = {
  lastSeq: number; turns: Turn[]; datasets: Record<string, PlaygroundDataset>; charts: Record<string, PlaygroundChart>;
  report: (PlaygroundReport & { version: number }) | null; agent: { state: string; model?: string } | null;
};
export const emptyView: View = { lastSeq: 0, turns: [], datasets: {}, charts: {}, report: null, agent: null };

/** Fold one event into the view. Events are applied in sequence order; replays are ignored. */
export function apply(view: View, event: PlaygroundEvent): View {
  if (event.seq <= view.lastSeq) return view;
  const next = { ...view, lastSeq: event.seq };
  const turns = [...view.turns];
  const at = (index: number, change: (turn: Turn) => Turn) => { if (index >= 0) turns[index] = change(turns[index]!); next.turns = turns; };
  let running = -1;
  turns.forEach((t, i) => { if (t.status === "running") running = i; });
  const bySeq = (seq?: number) => seq === undefined ? running : turns.findIndex(t => t.seq === seq);
  switch (event.kind) {
    case "user_message":
      turns.push({ seq: event.seq, text: event.data.text, source: event.data.source, status: "queued", timeline: [], draft: "", steps: {}, artifacts: [] });
      next.turns = turns; break;
    case "turn_started": at(bySeq(event.data.seq), t => ({ ...t, status: "running", startedAt: Date.parse(event.at) })); break;
    case "assistant_delta": at(running, t => ({ ...t, draft: t.draft + event.data.text })); break;
    case "assistant_message": at(running, t => ({ ...t, draft: "", timeline: [...t.timeline, { type: "note", text: event.data.text }] })); break;
    case "tool_started": at(running, t => {
      const step: Step = { ...event.data, status: "running", children: [] };
      const steps = { ...t.steps, [step.id]: step };
      const parent = step.parent ? steps[step.parent] : undefined;
      if (parent) { steps[parent.id] = { ...parent, children: [...parent.children, step.id] }; return { ...t, steps }; }
      // Text streamed before a tool call is a note even if its final message has not arrived yet.
      const timeline = t.draft.trim() ? [...t.timeline, { type: "note" as const, text: t.draft.trim() }] : t.timeline;
      return { ...t, steps, draft: "", timeline: [...timeline, { type: "step", id: step.id }] };
    }); break;
    case "tool_finished": at(running, t => {
      const step = t.steps[event.data.id];
      return step ? { ...t, steps: { ...t.steps, [step.id]: { ...step, status: event.data.ok ? "done" : "failed", summary: event.data.summary } } } : t;
    }); break;
    case "dataset": next.datasets = { ...view.datasets, [event.data.name]: event.data }; at(running, t => ({ ...t, artifacts: [...t.artifacts, `dataset:${event.data.name}`] })); break;
    case "chart": next.charts = { ...view.charts, [event.data.id]: event.data }; at(running, t => ({ ...t, artifacts: [...t.artifacts, `chart:${event.data.id}`] })); break;
    case "report": next.report = { ...event.data, version: (view.report?.version ?? 0) + 1 }; at(running, t => ({ ...t, artifacts: [...t.artifacts, "report"] })); break;
    case "turn_finished": at(bySeq(event.data.seq), t => {
      // The spoken reply is the last note; show it as the answer rather than as working notes.
      const last = t.timeline.at(-1);
      const timeline = last?.type === "note" && last.text === event.data.reply ? t.timeline.slice(0, -1) : t.timeline;
      return { ...t, status: "done", draft: "", timeline, reply: event.data.reply, usage: event.data.usage, durationMs: event.data.durationMs, finishedAt: Date.parse(event.at) };
    }); break;
    case "turn_failed": at(bySeq(event.data.seq), t => ({ ...finish(t), status: "failed", reason: event.data.reason, finishedAt: Date.parse(event.at) })); break;
    case "turn_cancelled":
      for (let i = 0; i < turns.length; i++) if (turns[i]!.status === "running" || turns[i]!.status === "queued") turns[i] = { ...finish(turns[i]!), status: "cancelled", reason: event.data.reason };
      next.turns = turns; break;
    case "session_status": next.agent = { state: event.data.state, model: event.data.model ?? view.agent?.model }; break;
  }
  return next;
}
function finish(turn: Turn): Turn {
  const steps = Object.fromEntries(Object.entries(turn.steps).map(([id, s]) => [id, s.status === "running" ? { ...s, status: "failed" as const } : s]));
  return { ...turn, steps, draft: "" };
}

export const reasons: Record<string, string> = {
  cancelled: "Stopped.", cancelled_before_start: "Stopped before it started.", tool_budget_exhausted: "Stopped: the analysis used its whole tool budget.",
  turn_timeout: "Stopped: the analysis ran out of time.", model_error: "The model could not respond. Try again.",
  agent_exited: "The analyst stopped unexpectedly. Try again.", agent_failed_to_start: "The analyst could not start. Try again shortly.",
};
