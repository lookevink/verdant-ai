import { dataResponse, unavailable } from "../../../../../../src/lib/climate-data";
import { getAcquisition } from "../../../../../../src/lib/acquisitions";

/** Request IDs are random UUIDs and status covers public source data only; polling never charges. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return dataResponse({ error: "request_not_found" }, 404);
  try {
    const record = await getAcquisition(id);
    if (!record) return dataResponse({ error: "request_not_found" }, 404);
    const response = dataResponse(record);
    if (!["ready", "failed"].includes(record.status)) response.headers.set("Retry-After", "5");
    return response;
  } catch { return unavailable(); }
}
