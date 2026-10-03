import { catalog, dataResponse, unavailable } from "../../../../src/lib/climate-data";
export async function GET() {
  try { return dataResponse({ datasets: await catalog() }); }
  catch { return unavailable(); }
}
