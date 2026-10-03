import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exampleRequest, queryResultSchema } from "@verdant/contracts";
import { openapi } from "@verdant/contracts/openapi";

async function main() {
const origin = process.argv[2];
if (!origin) throw new Error("Usage: contract-smoke.ts <origin>");
const response = await fetch(new URL("/api/v1/openapi.json", origin));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), openapi);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "verdant", components: openapi.components });
function validate(name: string, data: unknown) {
  const check = ajv.getSchema(`verdant#/components/schemas/${name}`);
  assert.ok(check, name);
  assert.ok(check(data), `${name}: ${JSON.stringify(check.errors)}`);
}
async function get(path: string, schema: string) {
  const response = await fetch(new URL(path, origin)); assert.equal(response.status, 200, path);
  const data = await response.json(); validate(schema, data); return data;
}
async function post(path: string, body: unknown) {
  return fetch(new URL(path, origin), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
await get("/api/health", "Health");
await get("/api/v1/capabilities", "Capabilities");
const catalog = await get("/api/v1/datasets", "Catalog");
assert.ok(catalog.datasets.length >= 2);
for (const dataset of catalog.datasets) {
  await get(`/api/v1/datasets/${dataset.id}`, "DatasetDetail");
  if (dataset.access_level === "demo") {
    await get(`/api/v1/datasets/${dataset.id}/observations?limit=2`, "ObservationPage");
    const layer = await get(`/api/v1/layers/${dataset.id}`, "TilePage");
    for (const tile of layer.tiles) {
      await get(`/api/v1/layers/${dataset.id}?tile=${tile.id}`, "TileDetail");
      await get(`/api/v1/layers/${dataset.id}/sample?tile=${tile.id}&row=0&col=0`, "PixelSample");
    }
  }
}
const { format: _format, ...input } = exampleRequest;
const validation = await post("/api/v1/data/validate", input); assert.equal(validation.status, 200);
validate("Validation", await validation.json());
const coverage = await post("/api/v1/data/resolve", input); assert.equal(coverage.status, 200);
const resolved = await coverage.json(); validate("Resolution", resolved); assert.equal(resolved.available, true);
const query = await post("/api/v1/data/query", { ...input, dataset_version: resolved.selection.datasetVersion });
assert.equal(query.status, 200); assert.equal(query.headers.get("content-disposition"), null);
const bytes = await query.text();
assert.equal(query.headers.get("content-digest"), `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`);
const result = queryResultSchema.parse(JSON.parse(bytes)); validate("QueryResult", result);
assert.equal(result.data.length, resolved.selection.rowCount);
assert.equal(result.manifest.dataSha256, createHash("sha256").update(JSON.stringify(result.data)).digest("hex"));
const csv = await post("/api/v1/data/query", { ...input, format: "csv", dataset_version: resolved.selection.datasetVersion });
assert.equal(csv.status, 200); assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
const csvBody = await csv.text(); assert.equal(csvBody.trim().split("\r\n").length, result.data.length + 1);
assert.ok(csv.headers.get("link")?.includes(result.manifest.datasetVersion));
assert.equal(csv.headers.get("content-digest"), `sha-256=:${createHash("sha256").update(csvBody).digest("base64")}:`);
for (const invalid of [{ ...input, format: "netcdf" }, { ...input, period: { start: "2003-02-30", end: "2003-03-01" } }]) {
  const r = await post("/api/v1/data/query", invalid); assert.equal(r.status, 422); validate("Error", await r.json());
}
const miss = await post("/api/v1/data/resolve", { ...input, period: { start: "2003-01-02", end: "2003-01-02" } });
const missBody = await miss.json(); validate("Resolution", missBody); assert.equal(missBody.available, false);
const hit = await post("/api/v1/data/requests", input); assert.equal(hit.status, 200); validate("DataRequestReady", await hit.json());
// An uncached request without payment gets an MPP challenge; nothing is queued or charged.
const unpaid = await post("/api/v1/data/requests", { ...input, period: { start: "1890-01-01", end: "1890-01-01" } });
assert.equal(unpaid.status, 402); assert.match(unpaid.headers.get("www-authenticate") ?? "", /^Payment /);

const client = new Client({ name: "verdant-contract-verifier", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin)));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  // Only request_data can start (paid) work; nothing is destructive.
  assert.deepEqual(tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name), ["request_data"]);
  assert.ok(tools.every(t => !t.annotations?.destructiveHint));
  const answer = await client.callTool({ name: "query_data", arguments: { ...input, dataset_version: resolved.selection.datasetVersion } });
  assert.ok(!answer.isError, JSON.stringify(answer));
  assert.deepEqual(answer.structuredContent, result);
  const rejected = await client.callTool({ name: "query_data", arguments: { ...input, format: "netcdf" } });
  assert.equal(rejected.isError, true);
  const resource = await client.readResource({ uri: "verdant://openapi" });
  assert.ok("text" in resource.contents[0]!);
  assert.deepEqual(JSON.parse(resource.contents[0]!.text as string), openapi);
} finally { await client.close(); }
console.log(JSON.stringify({ origin, status: "passed", checks: ["OpenAPI equality and response schemas", "catalog/observation/raster contracts", "direct JSON/CSV and checksums", "coverage rejection", "MCP tools and REST result parity"], rows: result.data.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
