import { readDataRequest } from "../../../../../src/lib/http";
import { dataResponse, dataStore, unavailable } from "../../../../../src/lib/climate-data";
import { resolveData } from "../../../../../src/lib/data-query";
export async function POST(request: Request) {
  const parsed = await readDataRequest(request);
  if (parsed.response) return parsed.response;
  try { return dataResponse(await resolveData(parsed.request, dataStore)); }
  catch { return unavailable(); }
}
