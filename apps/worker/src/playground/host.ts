// Playground supervisor: claims sessions that have unanswered messages and serves each with its own Pi process
// (agent.ts) while it holds the session lease. Pi events are batched into the session event log; follow-up messages
// and cancellations arrive in the same leased call. A session's Pi stays warm for a short idle period, then exits;
// its transcript stays on disk so the next claim resumes it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseRpc } from "@verdant/queue";

type Log = (event: string, details?: Record<string, unknown>) => void;
type Message = { seq: number; text: string; source?: string };
type Claim = { session: { id: string }; leaseToken: string; messages: Message[]; history: { role: string; text: string }[] };
type Emitted = { ok: boolean; cancel?: boolean; messages?: Message[] };
export type PlaygroundOptions = { rpc: DatabaseRpc; namespace: string; dataDir: string; log: Log; signal: AbortSignal;
  concurrency?: number; idleMs?: number; agentPath?: string; mcpUrl: string; skillsDir?: string };

const leaseSeconds = 60;
const agentPath = path.join(import.meta.dirname, "agent.ts");

/** The model credential and the public MCP URL are all that cross into Pi. */
export function playgroundEnvironment(dir: string, mcpUrl: string, skillsDir: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const allowed: Record<string, string | undefined> = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID: env.ANTHROPIC_WORKSPACE_ID,
    PI_MODEL: env.PI_MODEL, PI_THINKING: env.PI_THINKING, PLAYGROUND_TOOL_BUDGET: env.PLAYGROUND_TOOL_BUDGET,
    PLAYGROUND_TURN_TIMEOUT_MS: env.PLAYGROUND_TURN_TIMEOUT_MS, PATH: env.PATH, LANG: env.LANG, TMPDIR: env.TMPDIR, HOME: dir,
    VERDANT_MCP_URL: mcpUrl, PLAYGROUND_SKILLS_DIR: skillsDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  return Object.fromEntries(Object.entries(allowed).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Map Pi process events to event-log entries. Returns null for events the log does not keep. */
export function toLogEvent(event: Record<string, unknown>): { kind: string; data: Record<string, unknown> } | null {
  switch (event.type) {
    case "ready": return { kind: "session_status", data: { state: "ready", model: event.model } };
    case "message": return { kind: "assistant_message", data: { text: event.text } };
    case "tool_start": return { kind: "tool_started", data: { id: event.id, parent: event.parent, tool: event.tool, label: event.label, input: event.input } };
    case "tool_end": return { kind: "tool_finished", data: { id: event.id, parent: event.parent, tool: event.tool, ok: event.ok, summary: event.summary } };
    case "artifact": return ["dataset", "chart", "report"].includes(String(event.kind)) ? { kind: String(event.kind), data: event.data as Record<string, unknown> } : null;
    default: return null;
  }
}

/** Poll for sessions with unanswered messages and serve up to `concurrency` of them at once. */
export async function runPlayground(opts: PlaygroundOptions) {
  const worker = `${hostname().slice(0, 60)}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const active = new Map<string, Promise<void>>();
  const limit = opts.concurrency ?? 3;
  opts.log("playground_started", { worker, concurrency: limit, mcpUrl: opts.mcpUrl });
  while (!opts.signal.aborted) {
    let claimed: Claim | null = null;
    if (active.size < limit) {
      try { claimed = await opts.rpc("verdant_playground_claim", { p_namespace: opts.namespace, p_worker: worker, p_lease_seconds: leaseSeconds }) as Claim | null; }
      catch (error) { opts.log("playground_claim_failed", { message: (error as Error).message.slice(0, 200) }); }
    }
    if (claimed) {
      const id = claimed.session.id;
      active.set(id, serveSession(claimed, opts).catch(error => opts.log("playground_session_error", { id, message: (error as Error).message.slice(0, 300) }))
        .finally(() => active.delete(id)));
      continue;
    }
    try { await delay(1000, undefined, { signal: opts.signal }); } catch { break; }
  }
  await Promise.allSettled(active.values());
  opts.log("playground_stopped", { worker });
}

async function serveSession(claim: Claim, opts: PlaygroundOptions) {
  const { rpc, namespace, log } = opts, id = claim.session.id, lease = claim.leaseToken;
  const dir = path.join(opts.dataDir, "playground", namespace.replaceAll(":", "_"), id);
  await mkdir(dir, { recursive: true });
  log("playground_session_claimed", { id, messages: claim.messages.length, history: claim.history.length });
  const pending: Message[] = [...claim.messages];
  let seen = Math.max(0, ...pending.map(m => m.seq));
  let buffer: { kind: string; data: Record<string, unknown> }[] = [{ kind: "session_status", data: { state: "starting" } }];
  let done = null as number | null, current = null as Message | null, ready = false, idleSince = Date.now(), lost = false, exited = false;

  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), opts.agentPath ?? agentPath, dir], {
    cwd: dir, env: playgroundEnvironment(dir, opts.mcpUrl, opts.skillsDir), stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const send = (command: Record<string, unknown>) => { if (!exited) child.stdin.write(JSON.stringify(command) + "\n"); };
  const diagnostics: string[] = [];
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", l => { if (diagnostics.length < 20) diagnostics.push(l.slice(0, 300)); });
  const closed = new Promise<number | null>(resolve => child.on("close", code => { exited = true; resolve(code); }));

  const next = () => {
    if (!ready || current || !pending.length) return;
    current = pending.shift()!;
    buffer.push({ kind: "turn_started", data: { seq: current.seq } });
    // History lets a process without a local transcript (new machine, cleared disk) continue the conversation.
    send({ type: "prompt", seq: current.seq, text: current.text, history: claim.history });
  };
  createInterface({ input: child.stdio[3] as NodeJS.ReadableStream }).on("line", line => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "delta") {
      // Coalesce streamed text; an assistant_message later replaces the accumulated deltas.
      const last = buffer.at(-1);
      if (last?.kind === "assistant_delta") last.data.text += String(event.text);
      else buffer.push({ kind: "assistant_delta", data: { text: String(event.text) } });
      return;
    }
    if (event.type === "turn_end" && current) {
      const reason = String(event.reason ?? "");
      buffer.push(event.ok ? { kind: "turn_finished", data: { seq: current.seq, reply: event.reply, usage: event.usage, durationMs: event.durationMs } }
        : reason === "cancelled" ? { kind: "turn_cancelled", data: { reason, durationMs: event.durationMs } }
        : { kind: "turn_failed", data: { seq: current.seq, reason, durationMs: event.durationMs } });
      log("playground_turn_finished", { id, seq: current.seq, ok: event.ok, reason: event.reason, usage: event.usage, durationMs: event.durationMs });
      done = current.seq; current = null; idleSince = Date.now();
      return next();
    }
    if (event.type === "model_error" || event.type === "model_retry") log(`playground_${event.type}`, { id, error: event.error });
    if (event.type === "notice") log("playground_agent_notice", { id, level: event.level, message: event.message });
    const entry = toLogEvent(event);
    if (entry) buffer.push(entry);
    if (event.type === "ready") { ready = true; next(); }
  });

  // One leased call per tick writes buffered events, renews the lease and collects follow-ups and cancellation.
  const flush = async (final = false) => {
    const events = buffer; buffer = [];
    const doneSeq = done; done = null;
    // A failed write keeps its events and completion for the next tick (the RPCs are all-or-nothing).
    const call = <T>(name: string, args: Record<string, unknown>) => (rpc(name, args) as Promise<T>)
      .catch(error => { buffer = [...events, ...buffer]; done ??= doneSeq; throw error; });
    if (final) return await call<boolean>("verdant_playground_release", { p_namespace: namespace, p_id: id, p_lease_token: lease, p_events: events }) === true;
    const result = await call<Emitted>("verdant_playground_emit", { p_namespace: namespace, p_id: id, p_lease_token: lease, p_events: events,
      p_seen_seq: seen, p_done_seq: doneSeq, p_lease_seconds: leaseSeconds });
    if (!result.ok) return false;
    if (result.cancel && current) send({ type: "abort" });
    for (const m of result.messages ?? []) if (m.seq > seen) { pending.push(m); seen = m.seq; }
    next();
    return true;
  };
  try {
    let lastFlush = 0;
    while (!exited) {
      await Promise.race([delay(250), closed]);
      const idle = !current && !pending.length;
      if (opts.signal.aborted || (idle && ready && Date.now() - idleSince > (opts.idleMs ?? 120_000))) break;
      if (!buffer.length && done === null && Date.now() - lastFlush < 2000) continue;
      try { if (!await flush()) { lost = true; log("playground_lease_lost", { id }); break; } lastFlush = Date.now(); }
      catch (error) { log("playground_emit_failed", { id, message: (error as Error).message.slice(0, 200) }); await delay(1000); }
    }
  } finally {
    if (!exited) { child.stdin.end(); setTimeout(() => child.kill("SIGTERM"), 5000).unref(); }
    const code = await Promise.race([closed, delay(10_000).then(() => { child.kill("SIGKILL"); return null; })]);
    if (code !== 0) log("playground_agent_exit", { id, code, diagnostics });
    // A turn interrupted by a crash is marked done, so one failing message cannot loop forever. Shutdown and lost
    // leases leave it unconsumed for the next claim.
    if (current && !lost && !opts.signal.aborted) { buffer.push({ kind: "turn_failed", data: { seq: current.seq, reason: "agent_exited" } }); done = current.seq; }
    // Likewise a Pi process that never started fails the waiting messages instead of being reclaimed in a loop.
    else if (!ready && pending.length && !lost && !opts.signal.aborted) {
      buffer.push({ kind: "turn_failed", data: { seq: pending[0]!.seq, reason: "agent_failed_to_start" } });
      done = Math.max(...pending.map(m => m.seq));
    }
    buffer.push({ kind: "session_status", data: { state: "stopped" } });
    if (!lost) {
      try { if (done !== null) await flush(); await flush(true); } catch (error) { log("playground_release_failed", { id, message: (error as Error).message.slice(0, 200) }); }
    }
    log("playground_session_released", { id, lost });
  }
}
