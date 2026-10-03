import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_VERSION, capabilities, deliveryLimits } from "@verdant/contracts";
import { openapi, operationDescriptions, toolInputs } from "@verdant/contracts/openapi";
import { dataStore } from "./climate-data";
import { queryData, resolveData, QueryError, type DataStore } from "./data-query";
import { GET as getObservations } from "../../app/api/v1/datasets/[id]/observations/route";
import { GET as getLayer } from "../../app/api/v1/layers/[id]/route";
import { GET as getSample } from "../../app/api/v1/layers/[id]/sample/route";
import { chargeOptions, getAcquisition, paidAcquisition, prepareDataRequest, submitPaidAcquisition } from "./acquisitions";
import { acquisitionPrice, credentialHash, stripeMcpPayment } from "./payments";

const credentialKey = "org.paymentauth/credential", receiptKey = "org.paymentauth/receipt", paymentRequiredKey = "org.paymentauth/payment-required";
type Extra = { _meta?: Record<string, unknown> };
const structured = (data: Record<string, unknown>, extra: Partial<{ isError: boolean; _meta: Record<string, unknown> }> = {}) =>
  ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, ...extra });
/**
 * Published data is free. An identical acquisition already running is returned free. A new acquisition is
 * paid with MPP: the result carries the challenge in _meta (MCP SDK tool errors cannot carry JSON-RPC data),
 * and the paid retry carries the credential in _meta and gets the receipt back in _meta.
 */
async function requestData(request: Parameters<typeof prepareDataRequest>[0], extra: Extra) {
  const prepared = await prepareDataRequest(request);
  if (prepared.kind === "ready" || prepared.kind === "existing") return structured(prepared.body);
  if (prepared.kind === "rejected") return structured(prepared.body, { isError: true });
  const payments = stripeMcpPayment(), price = acquisitionPrice();
  const credential = extra._meta?.[credentialKey];
  const hash = credential === undefined ? null : credentialHash("verdant-acquisition-mcp", JSON.stringify(credential));
  if (hash) {
    const recovered = await paidAcquisition(hash);
    if (recovered) return structured({ ...recovered.record, cache: "miss" }, recovered.receipt ? { _meta: { [receiptKey]: JSON.parse(recovered.receipt) } } : {});
  }
  const payment = await payments.charge(chargeOptions(prepared.plan, price))(extra);
  if (payment.status === 402) {
    const challenge = payment.challenge as unknown as { message: string; data: unknown };
    return structured({ error: "payment_required", cache: "miss", amount: price.amount, currency: price.currency,
      message: `Acquiring this data costs ${price.amount} ${price.currency.toUpperCase()} via MPP. Retry the call with the credential in _meta["${credentialKey}"].` },
      { isError: true, _meta: { [paymentRequiredKey]: challenge.data } });
  }
  const stamped = payment.withReceipt({ content: [] }) as { _meta?: Record<string, unknown> };
  const receipt = stamped._meta?.[receiptKey] as { method: string; reference: string } | undefined;
  if (!receipt || !hash) throw new Error("Missing payment receipt or credential.");
  const record = await submitPaidAcquisition(prepared.plan, request, { provider: receipt.method, reference: receipt.reference,
    credentialHash: hash, receipt: JSON.stringify(receipt), amountMinor: price.amountMinor, currency: price.currency });
  return structured({ ...record, cache: "miss", paid: true }, { _meta: stamped._meta });
}

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
    instructions: "Discover capabilities and datasets, inspect provenance, resolve coverage, then query data. Query output is direct structured JSON. If coverage is missing, request_data acquires it from the source: published or already-running data is free, a new acquisition is paid with MPP (the payment challenge arrives in the result _meta). Poll get_request until ready, then call query_data. Missing values remain null. Weather pixels do not identify treatment effects.",
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
  server.registerTool("list_raster_tiles", { description: "List native tile metadata and coverage for a public dataset. Follow nextCursor until null.", inputSchema: toolInputs.page, annotations },
    ({ id, ...params }) => result(async () => (await getLayer(queryRequest(`/api/v1/layers/${id}`, params), { params: Promise.resolve({ id }) })).json()));
  server.registerTool("sample_raster", { description: openapi.paths["/api/v1/layers/{id}/sample"].get.description, inputSchema: toolInputs.sample, annotations },
    ({ id, ...params }) => result(async () => (await getSample(queryRequest(`/api/v1/layers/${id}/sample`, params), { params: Promise.resolve({ id }) })).json()));
  server.registerTool("request_data", { description: operationDescriptions.requestData, inputSchema: toolInputs.query,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    async (request, extra) => {
      try { return await requestData(request, extra as Extra); }
      catch { return structured({ error: "payment_or_fulfillment_failed", message: "Retry with the same credential if payment completed; it recovers the request without a second charge." }, { isError: true }); }
    });
  server.registerTool("get_request", { description: operationDescriptions.getDataRequest, inputSchema: toolInputs.requestId, annotations },
    ({ id }) => result(async () => (await getAcquisition(id)) ?? { error: "request_not_found" }));
  server.registerResource("openapi", "verdant://openapi", { mimeType: "application/json", description: "The same OpenAPI 3.1 contract used by REST and the Mintlify reference." },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(openapi) }] }));
  return server;
}
