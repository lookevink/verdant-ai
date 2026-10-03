// End-to-end cache-miss acquisition against an in-process Postgres (scripts/local-db.ts):
// API route handlers → pgmq → worker supervisor → agent → verification → publication → cache hit → query.
//   node --import tsx scripts/acquisition-e2e.ts            # Pi with the worker's production profile model credential
//   node --import tsx scripts/acquisition-e2e.ts --scripted # scripted agent stand-in; no model calls
//   node --import tsx scripts/acquisition-e2e.ts --remote   # hosted Supabase, sandbox partition, random uncached date
// Local data is in-memory and discarded; --remote publishes a real sandbox dataset version (never production).
// SILO source files are downloaded from the public bucket.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnv, root } from "./env-files.mjs";
import { createLocalDatabase, serveRpc } from "./local-db";

const scripted = process.argv.includes("--scripted"), remote = process.argv.includes("--remote");
const profile = await readEnv(path.join(root, "apps/worker/.env.production"));
const db = remote ? null : await createLocalDatabase();
const rpcServer = db ? await serveRpc(db, 58332) : null;
const supabase = rpcServer ? { url: rpcServer.url, key: rpcServer.secretKey } : { url: profile.SUPABASE_URL!, key: profile.SUPABASE_SECRET_KEY! };
const adminToken = randomBytes(24).toString("hex");
Object.assign(process.env, { VERDANT_ENV: "sandbox", PAYMENT_MODE: "test", QUEUE_NAMESPACE: "verdant:sandbox:test",
  SUPABASE_URL: supabase.url, SUPABASE_SECRET_KEY: supabase.key, API_ADMIN_TOKEN: adminToken });
const api = path.join(root, "apps/api/app/api/v1");
const requests = await import(path.join(api, "data/requests/route.ts"));
const status = await import(path.join(api, "data/requests/[id]/route.ts"));
const query = await import(path.join(api, "data/query/route.ts"));
const { decodeWindow, download } = await import(path.join(root, "apps/worker/src/acquisition/silo.ts"));

// Remote runs pick a random two-day period (1990–2019) so each run is a genuine cache miss.
const start = remote ? new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 10_950) * 86_400_000).toISOString().slice(0, 10) : "2003-01-02";
const end = new Date(Date.parse(start) + 86_400_000).toISOString().slice(0, 10);
const compact = (d: string) => d.replaceAll("-", "");
const body = { variables: ["air_temperature_max"], region: { bbox: [142.3, -34.45, 142.4, -34.35], crs: "EPSG:4326" },
  period: { start, end }, temporal_resolution: "daily", spatial_resolution: "native",
  units: { air_temperature_max: "degC" }, data_class: "interpolated_observation", format: "json", missing_policy: "preserve", source_preference: "silo" };
const post = (handler: (r: Request) => Promise<Response>, token?: string, payload: unknown = body) => handler(new Request("http://local/api", {
  method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }));
const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`✔ ${name}`); };

try {
  const unauthorized = await post(requests.POST);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).cache, "miss");
  pass("cache miss without a token is refused before queueing");
  const accepted = await post(requests.POST, adminToken);
  assert.equal(accepted.status, 202);
  const first = await accepted.json();
  assert.equal(first.created, true);
  assert.equal(first.status, "queued");
  const again = await (await post(requests.POST, adminToken, { ...body, format: "csv" })).json();
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  pass("concurrent identical miss (different format) reuses one acquisition");

  const started = Date.now();
  if (scripted) {
    const { createDatabaseRpc, JobQueue } = await import("@verdant/queue");
    const { processAcquisition, acquisitionLeaseMs } = await import(path.join(root, "apps/worker/src/acquisition/supervisor.ts"));
    const rpc = createDatabaseRpc(), queue = new JobQueue(rpc, "verdant:sandbox:test", "acquisition");
    const claimed = await queue.claim(acquisitionLeaseMs);
    assert.ok(claimed);
    const result = await processAcquisition(claimed, { rpc, queue, namespace: "verdant:sandbox:test",
      log: (event: string, details: unknown) => console.log(JSON.stringify({ event, details })),
      dataDir: await mkdtemp(path.join(tmpdir(), "verdant-e2e-")), agentPath: path.join(root, "apps/worker/test/scripted-agent.ts") });
    assert.equal(result.status, "ready", JSON.stringify(result));
  } else {
    const worker = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--once"], { cwd: path.join(root, "apps/worker"), stdio: "inherit",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, VERDANT_PROFILE_LOADED: "1", VERDANT_ENV: "sandbox", PAYMENT_MODE: "test",
        QUEUE_NAMESPACE: "verdant:sandbox:test", SUPABASE_URL: supabase.url, SUPABASE_SECRET_KEY: supabase.key,
        WORKER_DATA_DIR: await mkdtemp(path.join(tmpdir(), "verdant-e2e-")),
        ...Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "PI_MODEL"].filter(k => profile[k] || process.env[k]).map(k => [k, process.env[k] ?? profile[k]])) } });
    assert.equal(await new Promise(resolve => worker.on("close", resolve)), 0, "worker --once must publish the acquisition");
  }
  const polled = await status.GET(new Request("http://local"), { params: Promise.resolve({ id: first.id }) });
  const record = await polled.json();
  assert.equal(record.status, "ready", JSON.stringify(record.error));
  assert.match(record.datasetVersion, new RegExp(`^silo-tmax-${compact(start)}-${compact(end)}-[0-9a-f]{16}$`));
  const events = record.events.map((e: { event: string }) => e.event);
  for (const e of ["queued", "attempt_started", "tool_succeeded", "agent_finished", "verified", "ready"]) assert.ok(events.includes(e), `missing ${e}`);
  pass(`worker published ${record.datasetVersion} in ${((Date.now() - started) / 1000).toFixed(1)}s via ${scripted ? "scripted agent" : "Pi"}`);

  const hit = await post(requests.POST);
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), { status: "ready", cache: "hit", datasetVersion: record.datasetVersion, rowCount: 8,
    links: { query: "/api/v1/data/query", dataset: `/api/v1/datasets/${record.datasetVersion}` } });
  pass("the next identical request is a cache hit without a token");

  const result = await (await post(query.POST)).json();
  assert.equal(result.manifest.datasetVersion, record.datasetVersion);
  assert.equal(result.data.length, 8);
  // Independent check: decode the source window for each date here and compare every returned value.
  for (const date of [start, end]) {
    const source = await download("max_temp", date);
    const { cells } = await decodeWindow(source.body, { ...record.target, period: { start: date, end: date } });
    for (const row of result.data.filter((r: { date: string }) => r.date === date)) {
      const col = Math.round((row.longitude - 0.025 - 111.975) / 0.05) - record.target.window.col;
      const r = Math.round((-9.975 - row.latitude - 0.025) / 0.05) - record.target.window.row;
      assert.equal(row.value, cells[r * record.target.window.width + col], `${date} ${row.longitude},${row.latitude}`);
    }
  }
  pass("every queried value matches an independent decode of the SILO source");
  console.log(JSON.stringify({ status: "passed", agent: scripted ? "scripted" : "pi", database: remote ? "hosted sandbox partition" : "in-memory", checks }));
} finally {
  rpcServer?.server.close();
  await db?.close();
}
