import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_VERSION, capabilities, deliveryLimits } from "@verdant/contracts";
import { openapi, operationDescriptions, toolInputs } from "@verdant/contracts/openapi";
import { dataStore } from "./climate-data";
import { queryData, resolveData, QueryError, type DataStore } from "./data-query";
import { GET as getObservations } from "../../app/api/v1/datasets/[id]/observations/route";
import { GET as getLayer } from "../../app/api/v1/layers/[id]/route";
import { GET as getSample } from "../../app/api/v1/layers/[id]/sample/route";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
async function result(action: () => Promise<Record<string, unknown>>) {
  try {
    const data = await action();
    const text = JSON.stringify(data);
    const output = { content: [{ type: "text" as const, text }], structuredContent: data, ...(data.error ? { isError: true } : {}) };
    // Include both the legacy text and structured form; reserve space for the request ID/envelope.
    if (Buffer.byteLength(JSON.stringify(output)) > deliveryLimits.maxResponseBytes - 32_768) throw new QueryError("request_too_large", 413);
    return output;
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof QueryError ? error.code : "data_service_unavailable" }) }] };
  }
}
function queryRequest(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(path, "https://api.verdant-ai.com");
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return new Request(url);
}
export function createMcpServer(store: DataStore = dataStore) {
  const server = new McpServer({ name: "verdant-climate-data", version: API_VERSION }, {
    instructions: "Discover capabilities and datasets, inspect provenance, resolve coverage, then query data. Tools only read published public demo data. Query output is direct structured JSON. No tool purchases or acquires data. Missing values remain null. Weather pixels do not identify treatment effects.",
  });
  server.registerTool("get_capabilities", { description: operationDescriptions.getCapabilities, inputSchema: toolInputs.empty, annotations },
    () => result(async () => ({ ...capabilities })));
  server.registerTool("list_datasets", { description: operationDescriptions.listDatasets, inputSchema: toolInputs.empty, annotations },
    () => result(async () => ({ datasets: await store.catalog() })));
  server.registerTool("get_dataset", { description: operationDescriptions.getDataset, inputSchema: toolInputs.dataset, annotations },
    ({ id }) => result(async () => { const dataset = (await store.catalog()).find(d => d.id === id); return dataset ? { dataset } : { error: "dataset_not_found" }; }));
  server.registerTool("resolve_data", { description: operationDescriptions.resolveData, inputSchema: toolInputs.query, annotations },
    request => result(() => resolveData(request, store)));
  server.registerTool("query_data", { description: operationDescriptions.queryData + " This MCP tool returns structured JSON; use REST for CSV.", inputSchema: toolInputs.query, annotations },
    request => result(() => queryData(request, store)));
  server.registerTool("list_observations", { description: openapi.paths["/api/v1/datasets/{id}/observations"].get.description, inputSchema: toolInputs.page, annotations },
    ({ id, ...params }) => result(async () => (await getObservations(queryRequest(`/api/v1/datasets/${id}/observations`, params), { params: Promise.resolve({ id }) })).json()));
  server.registerTool("list_raster_tiles", { description: "List native tile metadata and coverage for a public demo dataset. Follow nextCursor until null.", inputSchema: toolInputs.page, annotations },
    ({ id, ...params }) => result(async () => (await getLayer(queryRequest(`/api/v1/layers/${id}`, params), { params: Promise.resolve({ id }) })).json()));
  server.registerTool("sample_raster", { description: openapi.paths["/api/v1/layers/{id}/sample"].get.description, inputSchema: toolInputs.sample, annotations },
    ({ id, ...params }) => result(async () => (await getSample(queryRequest(`/api/v1/layers/${id}/sample`, params), { params: Promise.resolve({ id }) })).json()));
  server.registerResource("openapi", "verdant://openapi", { mimeType: "application/json", description: "The same OpenAPI 3.1 contract used by REST and the Mintlify reference." },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(openapi) }] }));
  return server;
}
