// Paid acquisition end to end with real Stripe test-mode payments (no real money):
// REST 402 → MPP payment → 202 + receipt → credential replay without a second charge → free join of running work,
// MCP request_data challenge → paid tool call → receipt, worker publication, and a refund of a failed paid acquisition.
//   node --import tsx apps/api/scripts/paid-request-e2e.mts
// Uses an in-memory database, the scripted agent (no model calls) and the Stripe test key in .env.production.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Mppx, stripe } from "mppx/client";
import { McpClient } from "mppx/mcp/client";
import { createDatabaseRpc, JobQueue } from "@verdant/queue";
import { readEnv, root } from "../../../scripts/env-files.mjs";
import { createLocalDatabase, serveRpc } from "../../../scripts/local-db";

const profile = await readEnv(path.join(root, ".env.production"));
const stripeKey = profile.STRIPE_SECRET_KEY!;
assert.match(stripeKey, /^(sk|rk|rkcs)_test_/, "This test only runs with a Stripe test key.");
const db = await createLocalDatabase();
const rpcServer = await serveRpc(db, 58333);
const workerToken = randomBytes(24).toString("hex");
Object.assign(process.env, { VERDANT_ENV: "sandbox", PAYMENT_MODE: "test", QUEUE_NAMESPACE: "verdant:sandbox:test",
  SUPABASE_URL: rpcServer.url, SUPABASE_SECRET_KEY: rpcServer.secretKey, API_ADMIN_TOKEN: randomBytes(24).toString("hex"),
  VERDANT_WORKER_TOKEN: workerToken, MPP_SECRET_KEY: randomBytes(32).toString("hex"), MPP_PRICE_USD: "0.50", STRIPE_SECRET_KEY: stripeKey,
  STRIPE_PROFILE_ID: profile.STRIPE_PROFILE_ID || "profile_test_61VVxfHx9KMi5gkIBA6VVxfHM1SQgBts4PNNPcAh6DmC" });

const api = path.join(root, "apps/api/app");
const requests = await import(path.join(api, "api/v1/data/requests/route.ts"));
const status = await import(path.join(api, "api/v1/data/requests/[id]/route.ts"));
const refunds = await import(path.join(api, "api/internal/acquisitions/refunds/route.ts"));
const mcp = await import(path.join(api, "mcp/route.ts"));
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url!, "http://127.0.0.1:58334");
  const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const id = /^\/api\/v1\/data\/requests\/([^/]+)$/.exec(url.pathname)?.[1];
  const response: Response = url.pathname === "/mcp" ? await mcp.POST(request)
    : id ? await status.GET(request, { params: Promise.resolve({ id }) }) : await requests.POST(request);
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>(resolve => http.listen(58334, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:58334";

let payments = 0;
// Stripe's test helper mints a shared payment token for a test card, granted to the challenge's network ID.
const charge = stripe.charge({ paymentMethod: "pm_card_visa", createToken: async ({ paymentMethod, amount, currency, networkId, expiresAt }) => {
  const body = new URLSearchParams({ payment_method: paymentMethod!, "usage_limits[currency]": currency, "usage_limits[max_amount]": amount,
    "usage_limits[expires_at]": String(expiresAt), ...(networkId ? { "seller_details[network_id]": networkId } : {}) });
  const response = await fetch("https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens", { method: "POST", body,
    headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2026-07-29.preview" } });
  const token = await response.json() as { id?: string; error?: { message: string } };
  if (!response.ok || !token.id) throw new Error(`SPT creation failed: ${token.error?.message}`);
  payments++;
  return token.id;
} });
const sentAuthorizations: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const authorization = new Headers(init?.headers).get("authorization");
  if (authorization?.startsWith("Payment ")) sentAuthorizations.push(authorization);
  return fetch(input, init);
};
const payer = Mppx.create({ methods: [charge], polyfill: false, fetch: recordingFetch });
const body = (start: string, format = "json") => JSON.stringify({ variables: ["air_temperature_max"], region: { bbox: [142.3, -34.45, 142.4, -34.35], crs: "EPSG:4326" },
  period: { start, end: start }, temporal_resolution: "daily", spatial_resolution: "native", units: { air_temperature_max: "degC" },
  data_class: "interpolated_observation", format, missing_policy: "preserve", source_preference: "silo" });
const post = (payload: string, headers: Record<string, string> = {}, f: typeof fetch = fetch) =>
  f(`${origin}/api/v1/data/requests`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", ...headers } });
const count = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]!.n);
const pass = (name: string) => console.log(`✔ ${name}`);

try {
  const challenge = await post(body("2005-02-01"));
  assert.equal(challenge.status, 402);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /^Payment .*method="stripe"/);
  assert.equal(await count("select count(*)::int n from verdant.acquisitions"), 0);
  pass("a new acquisition without payment gets a 402 MPP challenge and queues nothing");

  const client = new Client({ name: "verdant-paid-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  const unpaid = await client.callTool({ name: "request_data", arguments: JSON.parse(body("2005-02-02")) });
  assert.equal(unpaid.isError, true);
  const required = (unpaid._meta as Record<string, { challenges?: { method: string }[] }>)?.["org.paymentauth/payment-required"];
  assert.equal(required?.challenges?.[0]?.method, "stripe");
  pass("MCP request_data without payment returns the MPP challenge in _meta");

  const paid = await post(body("2005-02-01"), {}, payer.fetch as typeof fetch);
  assert.equal(paid.status, 202, await paid.clone().text());
  const record = await paid.json();
  assert.ok(paid.headers.get("payment-receipt"));
  assert.equal(record.paid, true); assert.equal(record.created, true);
  assert.equal(payments, 1);
  pass(`paid $0.50 in Stripe test mode → 202, receipt, request ${record.id}`);

  const replay = await post(body("2005-02-01"), { Authorization: sentAuthorizations.at(-1)! });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, record.id);
  assert.equal(await count("select count(*)::int n from verdant.payment_operations"), 1);
  pass("replaying the same credential recovers the request without a second charge");

  const joined = await post(body("2005-02-01", "csv"));
  assert.equal(joined.status, 202);
  assert.equal((await joined.json()).id, record.id);
  pass("an identical request while it runs joins it for free");

  McpClient.wrap(client, { methods: [charge] });
  const mcpPaid = await client.callTool({ name: "request_data", arguments: JSON.parse(body("2005-02-02")) }) as { structuredContent: { id: string; paid: boolean }; receipt?: unknown; isError?: boolean };
  assert.ok(!mcpPaid.isError, JSON.stringify(mcpPaid));
  assert.equal(mcpPaid.structuredContent.paid, true);
  assert.ok(mcpPaid.receipt);
  assert.equal(payments, 2);
  pass(`MCP request_data: challenge in _meta, then paid tool call with receipt (request ${mcpPaid.structuredContent.id})`);

  const rpc = createDatabaseRpc(), queue = new JobQueue(rpc, "verdant:sandbox:test", "acquisition");
  const { processAcquisition, acquisitionLeaseMs } = await import(path.join(root, "apps/worker/src/acquisition/supervisor.ts"));
  const first = (await queue.claim(acquisitionLeaseMs))!;
  const result = await processAcquisition(first, { rpc, queue, namespace: "verdant:sandbox:test", log: () => {},
    dataDir: await mkdtemp(path.join(tmpdir(), "verdant-paid-")), agentPath: path.join(root, "apps/worker/test/scripted-agent.ts") });
  assert.equal(result.status, "ready");
  const ready = await (await fetch(`${origin}/api/v1/data/requests/${first.job.id}`)).json();
  assert.ok(ready.events.some((e: { event: string }) => e.event === "payment_verified"));
  pass(`worker published the paid request (${ready.datasetVersion})`);

  // Simulate a permanent failure of the MCP-paid acquisition, then sweep refunds as the worker would.
  const second = (await queue.claim(acquisitionLeaseMs))!;
  await rpc("verdant_abandon_acquisition", { p_namespace: "verdant:sandbox:test", p_id: second.job.id, p_lease_token: second.leaseToken, p_reason: "source_unavailable: test" });
  const sweep = await refunds.POST(new Request(`${origin}/api/internal/acquisitions/refunds`, { method: "POST", headers: { Authorization: `Bearer ${workerToken}` } }));
  const swept = await sweep.json();
  assert.equal(sweep.status, 200, JSON.stringify(swept));
  assert.equal(swept.processed, 1, JSON.stringify(swept));
  assert.ok(["refunded", "refund_pending"].includes(swept.results[0].status), JSON.stringify(swept));
  assert.equal(await count("select count(*)::int n from verdant.payment_operations where status in ('refunded','refund_pending')"), 1);
  pass(`failed paid acquisition refunded through Stripe (${swept.results[0].status})`);
  await client.close();
  console.log(JSON.stringify({ status: "passed", stripeTestPayments: payments }));
} finally {
  http.close(); rpcServer.server.close(); await db.close();
}
