import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp";
import { POST } from "../../app/mcp/route";
import { deliveryLimits, type Dataset } from "@verdant/contracts";

test("MCP bounds the complete tool result including duplicate text and structured data", async () => {
  const dataset: Dataset = { id: "silo-test", dataset_key: "silo-test", title: "x".repeat(600_000), content_sha256: "a".repeat(64),
    source_manifest: [{ sha256: "b".repeat(64) }], transform_version: "v1", data_class: "interpolated_observation",
    variables: { air_temperature_max: "degC" }, temporal_resolution: "daily", spatial_support: {},
    period_start: "2003-01-01", period_end: "2003-01-01", license: "CC-BY-4.0", attribution: "test", access_level: "demo", metadata: {} };
  const server = createMcpServer({ async catalog() { return [dataset]; }, async tiles() { return []; }, async tile() { throw new Error("Unused"); } });
  const client = new Client({ name: "size-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "list_datasets", arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result).includes("request_too_large"));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < deliveryLimits.maxResponseBytes);
  } finally { await client.close(); await server.close(); }
});

test("MCP rejects batches, excessive bodies and untrusted browser origins before dispatch", async () => {
  const request = (body: string, origin?: string) => new Request("https://api.verdant-ai.com/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body,
  });
  assert.equal((await POST(request('[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]'))).status, 400);
  assert.equal((await POST(request(JSON.stringify({ padding: "x".repeat(33_000) })))).status, 413);
  assert.equal((await POST(request("{}", "https://untrusted.example"))).status, 403);
});
