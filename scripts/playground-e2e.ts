// End-to-end playground sessions against an in-process Postgres (scripts/local-db.ts):
// API route handlers → session event log → worker supervisor → agent process → events read back as the browser does.
//   node --import tsx scripts/playground-e2e.ts        # scripted agent stand-in; no model calls
//   node --import tsx scripts/playground-e2e.ts --pi   # Pi + Claude (worker production profile credential) on the public MCP
// Local data is in-memory and discarded.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnv, root } from "./env-files.mjs";
import { createLocalDatabase, serveRpc } from "./local-db";

const pi = process.argv.includes("--pi");
const profile = await readEnv(path.join(root, "apps/worker/.env.production"));
const db = await createLocalDatabase();
const rpcServer = await serveRpc(db, 58333);
Object.assign(process.env, { VERDANT_ENV: "sandbox", PAYMENT_MODE: "test", QUEUE_NAMESPACE: "verdant:sandbox:test",
  SUPABASE_URL: rpcServer.url, SUPABASE_SECRET_KEY: rpcServer.secretKey, PLAYGROUND_ACCESS_CODE: "e2e-access",
  PLAYGROUND_VOICE_SECRET: randomBytes(32).toString("hex"), PLAYGROUND_VOICE_URL: "ws://127.0.0.1:3004/live" });
if (pi) for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "PI_MODEL"]) process.env[key] ??= profile[key];
const api = path.join(root, "apps/api/app/api/v1/playground/sessions");
const sessions = await import(path.join(api, "route.ts"));
const messages = await import(path.join(api, "[id]/messages/route.ts"));
const eventsRoute = await import(path.join(api, "[id]/events/route.ts"));
const cancel = await import(path.join(api, "[id]/cancel/route.ts"));
const voice = await import(path.join(api, "[id]/voice/route.ts"));
const { runPlayground } = await import(path.join(root, "apps/worker/src/playground/host.ts"));
const { createDatabaseRpc } = await import("@verdant/queue");

type Event = { seq: number; kind: string; data: Record<string, unknown> };
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`✔ ${name}`); };
const stop = new AbortController();
let host: Promise<void> | null = null;

try {
  assert.equal((await sessions.POST(new Request("http://local/api", json({ accessCode: "wrong" })))).status, 401);
  const created = await sessions.POST(new Request("http://local/api", json({ accessCode: "e2e-access" })));
  assert.equal(created.status, 201);
  const { id, token } = await created.json();
  const auth = { Authorization: `Bearer ${token}` };
  const params = { params: Promise.resolve({ id }) };
  assert.equal((await eventsRoute.GET(new Request("http://local/api", { headers: { Authorization: `Bearer ${"x".repeat(43)}` } }), params)).status, 404);
  pass("sessions need the access code, and events need the session token");

  const page = async (after = 0) => (await (await eventsRoute.GET(new Request(`http://local/api?after=${after}`, { headers: auth }), params)).json()) as { status: string; events: Event[] };
  const send = async (text: string) => {
    const response = await messages.POST(new Request("http://local/api", json({ text }, auth)), params);
    assert.equal(response.status, 202);
    return (await response.json()).seq as number;
  };
  const waitFor = async (predicate: (events: Event[]) => boolean, ms = pi ? 420_000 : 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 300))) {
      const events = (await page()).events;
      if (predicate(events)) return events;
    }
    throw new Error(`Timed out; last events: ${JSON.stringify((await page()).events.map(e => e.kind))}`);
  };
  const finished = (seq: number) => (events: Event[]) => events.some(e => ["turn_finished", "turn_failed", "turn_cancelled"].includes(e.kind)
    && (e.data.seq === seq || e.kind === "turn_cancelled") && e.seq > seq);

  const question = pi ? "What were the hottest and coolest days near Mildura in January 2004? Chart it and write a short report." : "How hot was January 2004?";
  const first = await send(question);
  host = runPlayground({ rpc: createDatabaseRpc(), namespace: "verdant:sandbox:test", dataDir: await mkdtemp(path.join(tmpdir(), "verdant-playground-")),
    signal: stop.signal, idleMs: pi ? 30_000 : 4000, mcpUrl: process.env.VERDANT_MCP_URL ?? "https://api.verdant-ai.com/mcp", skillsDir: path.join(root, "skills"),
    agentPath: pi ? undefined : path.join(root, "apps/worker/test/scripted-playground-agent.ts"),
    log: (event: string, details?: Record<string, unknown>) => { if (pi || process.env.E2E_DEBUG || /failed|error|exit|lost/.test(event)) console.log(JSON.stringify({ event, ...details })); } });
  const started = Date.now();
  let events = await waitFor(finished(first));
  const kinds = events.map(e => e.kind);
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1), "sequence numbers are contiguous");
  for (const kind of ["user_message", "session_status", "turn_started", "tool_started", "tool_finished", "dataset", "chart", "report", "turn_finished"])
    assert.ok(kinds.includes(kind), `missing ${kind}: ${kinds.join(",")}`);
  const reply = events.find(e => e.kind === "turn_finished")!.data.reply as string;
  assert.ok(reply.length > 0);
  if (!pi) {
    assert.deepEqual(events.filter(e => e.kind === "assistant_delta").map(e => e.data.text), ["Looking at January."], "deltas are coalesced");
    assert.equal(events.find(e => e.kind === "tool_started" && e.data.id === "t2")?.data.parent, "t1");
    assert.deepEqual((events.find(e => e.kind === "dataset")!.data.rows as unknown[])[1], { date: "2004-01-02", tmax_c: null });
  }
  pass(`first turn: ${kinds.length} ordered events with trail, dataset, chart and report in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  reply: ${reply}`);

  if (!pi) {
    const sse = new AbortController();
    const stream = await eventsRoute.GET(new Request("http://local/api?after=0", { headers: { ...auth, Accept: "text/event-stream" }, signal: sse.signal }), params);
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    let text = "";
    while (!text.includes("event: session")) text += new TextDecoder().decode((await reader.read()).value);
    sse.abort(); await reader.cancel();
    assert.ok(text.startsWith("id: 1\ndata: "), text.slice(0, 80));
    assert.equal([...text.matchAll(/^id: (\d+)$/gm)].length, events.length);
    pass("event stream replays the log with SSE ids, then reports session status");

    const followUp = await send("And February?");
    events = await waitFor(finished(followUp));
    assert.equal(events.filter(e => e.kind === "session_status" && e.data.state === "starting").length, 1, "a warm session reuses its Pi process");
    assert.equal(events.at(-1)!.data.reply, "Answered: And February?");
    pass("a follow-up is answered by the same warm Pi process");

    const slow = await send("slow analysis");
    await waitFor(e => e.some(x => x.kind === "tool_started" && x.seq > slow));
    assert.equal((await cancel.POST(new Request("http://local/api", { method: "POST", headers: auth }), params)).status, 202);
    events = await waitFor(e => e.some(x => x.kind === "turn_cancelled" && x.seq > slow));
    pass("cancel aborts a running turn");

    const crash = await send("crash please");
    events = await waitFor(e => e.some(x => x.kind === "turn_failed" && x.data.seq === crash));
    assert.equal(events.find(x => x.kind === "turn_failed" && x.data.seq === crash)!.data.reason, "agent_exited");
    const recovered = await send("after the failure");
    events = await waitFor(finished(recovered));
    const report = events.filter(e => e.kind === "report").at(-1)!.data.markdown as string;
    assert.match(report, /History entries: [1-9]/);
    pass("a crashed turn fails once; the next message starts a new Pi with the recorded history");

    await waitFor(e => e.filter(x => x.kind === "session_status" && x.data.state === "stopped").length >= 2, 15_000);
    assert.equal((await page()).status, "idle");
    pass("an idle session releases its lease and stops Pi");

    const ticket = await (await voice.POST(new Request("http://local/api", { method: "POST", headers: auth }), params)).json();
    assert.match(ticket.ticket, new RegExp(`^${id}\\.\\d+\\.[A-Za-z0-9_-]{43}$`));
    assert.equal((await voice.POST(new Request("http://local/api", { method: "POST", headers: { Authorization: `Bearer ${"y".repeat(43)}` } }), params)).status, 404);
    pass("voice tickets are signed per session and require its token");
  }
  console.log(JSON.stringify({ status: "passed", agent: pi ? "pi" : "scripted", checks }));
} finally {
  stop.abort();
  await host;
  rpcServer.server.close();
  await db.close();
}
