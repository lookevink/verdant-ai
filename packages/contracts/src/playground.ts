import { z } from "zod";

/** Playground limits shared by the API (enforced), the worker (enforced) and the browser (displayed). */
export const playgroundLimits = {
  maxMessageChars: 4000, maxTurns: 20, dailySessionsPerClient: 30,
  maxDatasetRows: 5000, maxDatasetBytes: 1_000_000, maxCharts: 24, maxReportChars: 60_000,
} as const;

export const playgroundMessageSchema = z.object({
  text: z.string().trim().min(1).max(playgroundLimits.maxMessageChars),
  source: z.enum(["text", "voice"]).default("text"),
}).strict();
export const playgroundCreateSchema = z.object({ accessCode: z.string().max(200).optional() }).strict();

export type PlaygroundColumn = { name: string; label?: string; unit?: string; description?: string };
/** A table the agent derived or retrieved. Charts and the report refer to it by name. */
export type PlaygroundDataset = {
  name: string; title: string; description?: string; columns: PlaygroundColumn[];
  rows: Record<string, string | number | boolean | null>[]; rowCount: number;
  /** Verdant versions, hashes and attribution the rows came from. */
  provenance: { datasetVersion?: string; contentSha256?: string; attribution?: string; license?: string; note?: string }[];
};
/** A Vega-Lite spec whose `data: { name }` entries refer to datasets. */
export type PlaygroundChart = { id: string; title: string; caption?: string; spec: Record<string, unknown>; datasets: string[] };
/** Markdown with GFM tables and $…$/$$…$$ math. `![caption](chart:id)` and `![caption](dataset:name)` embed artifacts. */
export type PlaygroundReport = { title: string; markdown: string };
export type PlaygroundUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; turns: number };

type Event<K extends string, D> = { seq: number; at: string; kind: K; data: D };
export type PlaygroundEvent =
  | Event<"user_message", { text: string; source: "text" | "voice" }>
  | Event<"session_status", { state: "starting" | "ready" | "stopped"; model?: string; reason?: string }>
  | Event<"turn_started", { seq: number }>
  /** Streamed text of the current assistant message; `assistant_message` replaces the accumulated deltas. */
  | Event<"assistant_delta", { text: string }>
  | Event<"assistant_message", { text: string }>
  | Event<"tool_started", { id: string; parent?: string; tool: string; label: string; input?: string }>
  | Event<"tool_finished", { id: string; parent?: string; tool: string; ok: boolean; summary?: string }>
  | Event<"dataset", PlaygroundDataset>
  | Event<"chart", PlaygroundChart>
  | Event<"report", PlaygroundReport>
  /** `reply` is the short conversational answer the avatar speaks. */
  | Event<"turn_finished", { seq: number; reply: string; usage?: PlaygroundUsage; durationMs: number }>
  | Event<"turn_cancelled", { reason: string }>
  | Event<"turn_failed", { seq?: number; reason: string }>;
export type PlaygroundEventKind = PlaygroundEvent["kind"];
export type PlaygroundSession = { id: string; status: "idle" | "queued" | "running" | "closed"; turns: number; lastSeq: number; createdAt: string; updatedAt: string };
export type PlaygroundEventPage = PlaygroundSession & { events: PlaygroundEvent[] };
