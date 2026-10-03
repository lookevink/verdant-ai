import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquisitionTargetSchema, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import type { ClaimedJob, DatabaseRpc, JobQueue } from "@verdant/queue";
import { modelSpec } from "./model";
import { pruneSources, Workspace } from "./operations";
import { buildPublication, VerificationError } from "./publication";

export const acquisitionLeaseMs = 90_000;
const agentPath = path.join(import.meta.dirname, "agent.ts");
const stages: Record<string, "acquiring" | "normalizing" | "validating"> = {
  inspect_source: "acquiring", fetch_source: "acquiring", normalize_source: "normalizing", validate_output: "validating", submit_manifest: "validating",
};
const order = ["acquiring", "normalizing", "validating", "publishing"];
type Log = (event: string, details?: Record<string, unknown>) => void;
export type AgentOutcome = { submitted: boolean; model?: string; usage?: Record<string, number>; toolCalls?: number; finalMessage?: string | null };

/** Only the model credential crosses into Pi. HOME points at the job directory so no personal Pi config is read. */
export function agentEnvironment(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const allowed: Record<string, string | undefined> = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID: env.ANTHROPIC_WORKSPACE_ID,
    PI_MODEL: env.PI_MODEL, PI_THINKING: env.PI_THINKING,
    PI_TIMEOUT_MS: env.PI_TIMEOUT_MS, PATH: env.PATH, LANG: env.LANG, TMPDIR: env.TMPDIR, HOME: dir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  return Object.fromEntries(Object.entries(allowed).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Compact, credential-free event details for the public request log. */
function sanitize(event: Record<string, unknown>) {
  const text = JSON.stringify(event, (key, value) => key === "cells" ? undefined : value);
  return text.length <= 4000 ? JSON.parse(text) as Record<string, unknown> : { tool: event.tool, ok: event.ok, truncated: true };
}

/** Run Pi in a child process; resolve with its result line. Kills it on timeout or abort. */
export async function runAgent(ws: Workspace, opts: { signal: AbortSignal; onEvent: (e: Record<string, unknown>) => void; log: Log; agentPath?: string }) {
  // An absolute loader path: the child's cwd is the job directory, where a bare "tsx" would not resolve.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), opts.agentPath ?? agentPath, ws.dir], {
    cwd: ws.dir, env: agentEnvironment(ws.dir), stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let outcome: AgentOutcome = { submitted: false };
  const kill = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); };
  opts.signal.addEventListener("abort", kill, { once: true });
  const hardLimit = setTimeout(kill, (Number(process.env.PI_TIMEOUT_MS) || 480_000) + 60_000);
  const lines = createInterface({ input: child.stdio[3] as NodeJS.ReadableStream });
  lines.on("line", line => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") outcome = event as unknown as AgentOutcome;
      else opts.onEvent(event);
    } catch { /* ignore malformed lines */ }
  });
  const diagnostics: string[] = [];
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream! }).on("line", l => { if (diagnostics.length < 20) diagnostics.push(l.slice(0, 300)); });
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  clearTimeout(hardLimit);
  opts.signal.removeEventListener("abort", kill);
  if (code !== 0) opts.log("agent_exit", { code, diagnostics });
  return { ...outcome, exitCode: code };
}

/** agentPath replaces Pi only in tests that exercise the supervisor without a model. */
type Context = { rpc: DatabaseRpc; queue: JobQueue; namespace: string; dataDir: string; log: Log; agentPath?: string };
/** Process one claimed acquisition: Pi acquires and validates, the supervisor re-verifies and publishes atomically. */
export async function processAcquisition(claimed: ClaimedJob, ctx: Context) {
  const { rpc, queue, namespace, log } = ctx, id = claimed.job.id, lease = claimed.leaseToken;
  const call = (name: string, args: Record<string, unknown>) => rpc(name, { p_namespace: namespace, p_id: id, p_lease_token: lease, ...args });
  let stage = "acquiring";
  const progress = async (event: string, status: string | null, details: Record<string, unknown> = {}) => {
    if (status && order.indexOf(status) < order.indexOf(stage)) status = null; // Pi may loop back; public stages only move forward.
    if (status) stage = status;
    if (await call("verdant_acquisition_progress", { p_event: event, p_status: status, p_details: details }) !== true) throw new LeaseLost();
  };
  // Keep the lease alive while Pi works; losing it stops the agent and abandons this attempt without acknowledging.
  const lost = new AbortController();
  const keeper = setInterval(() => {
    queue.renew(claimed, acquisitionLeaseMs).then(ok => { if (!ok) lost.abort(); }, () => log("lease_renew_error", { id }));
  }, 20_000);
  try {
    const record = await rpc("verdant_get_acquisition", { p_namespace: namespace, p_id: id }) as { target: unknown; status: string } | null;
    if (!record) throw new PermanentFailure("acquisition_record_missing");
    let target: AcquisitionTarget;
    try { target = acquisitionTargetSchema.parse(record.target); } catch { throw new PermanentFailure("unsupported_target"); }
    const model = modelSpec().label;
    await progress("attempt_started", "acquiring", { attempt: claimed.job.attempts, model, agent: "pi" });
    const ws = await Workspace.create(path.join(ctx.dataDir, namespace.replaceAll(":", "_"), id, `attempt-${claimed.job.attempts}`),
      { acquisitionId: id, attempt: claimed.job.attempts, target });
    // Events are recorded in order; a transient write error is logged, a lost lease stops the agent.
    let recorded: Promise<void> = Promise.resolve();
    const outcome = await runAgent(ws, { signal: lost.signal, log, agentPath: ctx.agentPath, onEvent: event => {
      const tool = String(event.tool ?? "");
      const name = event.type === "tool_start" ? "tool_started" : event.type === "tool_end" ? (event.ok ? "tool_succeeded" : "tool_failed") : String(event.type);
      recorded = recorded.then(() => progress(name.replace(/[^a-z0-9_]/g, "_"), stages[tool] ?? null, sanitize(event)))
        .catch(error => { if (error instanceof LeaseLost) lost.abort(); else log("progress_write_failed", { id, event: name }); });
    } });
    await recorded;
    if (lost.signal.aborted) throw new LeaseLost();
    await progress("agent_finished", null, { submitted: outcome.submitted, model: outcome.model ?? model, toolCalls: outcome.toolCalls ?? 0,
      usage: outcome.usage ?? {}, exitCode: outcome.exitCode, message: outcome.finalMessage ?? null });
    const permanent = await ws.readJson<{ reason: string }>("permanent-failure.json");
    if (permanent && !outcome.submitted) throw new PermanentFailure(permanent.reason);
    if (!outcome.submitted) throw new Error(outcome.exitCode === 1 ? "agent_failed_to_start" : "agent_did_not_submit");
    await progress("verification_started", "validating");
    const publication = await buildPublication(ws, { model: outcome.model ?? model });
    await progress("verified", "publishing", { datasetVersion: publication.dataset.id, ...publication.stats });
    // Publication is replay-safe: a retry after a lost response returns true without writing twice.
    let published: unknown;
    for (let attempt = 1; ; attempt++) {
      try { published = await call("verdant_publish_acquisition", { p_dataset: publication.dataset, p_tiles: publication.tiles }); break; }
      catch (error) { if (attempt >= 3) throw error; await delay(2000 * attempt); }
    }
    if (published !== true) throw new LeaseLost();
    await pruneSources(ws);
    log("acquisition_published", { id, datasetVersion: publication.dataset.id, ...publication.stats, usage: outcome.usage });
    return { status: "ready" as const, datasetVersion: publication.dataset.id };
  } catch (error) {
    if (error instanceof LeaseLost || lost.signal.aborted) { log("acquisition_lease_lost", { id }); return { status: "lease_lost" as const }; }
    if (error instanceof PermanentFailure) {
      await rpc("verdant_abandon_acquisition", { p_namespace: namespace, p_id: id, p_lease_token: lease, p_reason: error.message });
      log("acquisition_abandoned", { id, reason: error.message });
      return { status: "failed" as const, reason: error.message };
    }
    const reason = error instanceof VerificationError ? `verification_failed: ${error.message}` : (error as Error).message || "acquisition_failed";
    // Back off between attempts: 30s, 60s. The final attempt marks the acquisition failed.
    await queue.fail(claimed, reason, 30_000 * claimed.job.attempts);
    log("acquisition_attempt_failed", { id, attempt: claimed.job.attempts, reason });
    return { status: "retry_or_failed" as const, reason };
  } finally {
    clearInterval(keeper);
  }
}
class LeaseLost extends Error {}
class PermanentFailure extends Error {}
