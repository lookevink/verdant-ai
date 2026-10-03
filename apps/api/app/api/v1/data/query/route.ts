import { API_VERSION, deliveryLimits } from "@verdant/contracts";
import { readDataRequest } from "../../../../../src/lib/http";
import { dataResponse, dataStore, unavailable } from "../../../../../src/lib/climate-data";
import { queryData, csvData, QueryError, responseDigest } from "../../../../../src/lib/data-query";
export async function POST(request: Request) {
  const parsed = await readDataRequest(request);
  if (parsed.response) return parsed.response;
  try {
    const result = await queryData(parsed.request, dataStore);
    const csv = parsed.request.format === "csv";
    const body = csv ? csvData(result.data) : JSON.stringify(result);
    if (Buffer.byteLength(body) > deliveryLimits.maxResponseBytes) return dataResponse({ error: "response_too_large" }, 413);
    return new Response(body, { headers: {
      "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json", "Cache-Control": "no-store",
      "Verdant-API-Version": API_VERSION, "Verdant-Dataset-Version": result.manifest.datasetVersion,
      "Verdant-Request-SHA256": result.manifest.requestSha256, "Content-Digest": responseDigest(body),
      Link: `</api/v1/datasets/${result.manifest.datasetVersion}>; rel="describedby"; type="application/json"`,
    } });
  } catch (error) {
    return error instanceof QueryError ? dataResponse({ error: error.code, message: "No complete supported result can be returned. Inspect /api/v1/data/resolve and the dataset coverage." }, error.status) : unavailable();
  }
}
