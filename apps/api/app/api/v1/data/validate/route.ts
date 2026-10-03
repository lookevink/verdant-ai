import { readDataRequest } from "../../../../../src/lib/http";
import { dataResponse } from "../../../../../src/lib/climate-data";
export async function POST(request: Request) {
  const parsed = await readDataRequest(request);
  if (parsed.response) return parsed.response;
  return dataResponse({ valid: true, request: parsed.request, coverageVerified: false, acquisitionEnabled: false,
    message: "Request structure is valid. Use /api/v1/data/resolve to check published coverage." });
}
