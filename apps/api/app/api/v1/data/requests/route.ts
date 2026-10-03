import { planAcquisition } from "@verdant/contracts/acquisition";
import { readDataRequest } from "../../../../../src/lib/http";
import { dataResponse, dataStore, unavailable } from "../../../../../src/lib/climate-data";
import { resolveData } from "../../../../../src/lib/data-query";
import { submitAcquisition } from "../../../../../src/lib/acquisitions";
import { isAdmin } from "../../../../../src/lib/services";

/**
 * Cache hit: 200 with the published version to query. Cache miss: plan a bounded SILO acquisition and
 * enqueue it (202). Acquisition runs a model session, so it requires the API bearer token until paid
 * MPP requests replace that gate. Nothing here charges.
 */
export async function POST(request: Request) {
  const parsed = await readDataRequest(request);
  if (parsed.response) return parsed.response;
  let resolution;
  try { resolution = await resolveData(parsed.request, dataStore); } catch { return unavailable(); }
  if (resolution.available) return dataResponse({ status: "ready", cache: "hit", datasetVersion: resolution.selection!.datasetVersion,
    rowCount: resolution.selection!.rowCount, links: { query: "/api/v1/data/query", dataset: `/api/v1/datasets/${resolution.selection!.datasetVersion}` } });
  const plan = planAcquisition(parsed.request);
  if (!plan.ok) return dataResponse({ error: plan.reason, message: plan.message }, plan.reason === "request_too_large" ? 413 : 422);
  if (!isAdmin(request)) return dataResponse({ error: "acquisition_unauthorized", cache: "miss",
    message: "Published coverage does not satisfy this request. Acquiring it requires an authorized bearer token." }, 401);
  try {
    const record = await submitAcquisition(plan, parsed.request, "api_admin");
    const response = dataResponse({ ...record, cache: "miss" }, 202);
    response.headers.set("Location", record.links.self!);
    response.headers.set("Retry-After", "10");
    return response;
  } catch { return unavailable(); }
}
