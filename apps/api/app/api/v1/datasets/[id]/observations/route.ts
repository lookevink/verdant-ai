import { climateRpc, demoDataset, dataResponse, unavailable } from "../../../../../../src/lib/climate-data";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  const after = params.get("after") ?? "";
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || after.length > 256)
    return dataResponse({ error: "invalid_pagination" }, 400);
  try {
    if (!await demoDataset(id)) return dataResponse({ error: "dataset_not_found_or_requires_entitlement" }, 404);
    // Read one extra record for an exact cursor; cap includes the sentinel.
    const count = limit;
    const rows = await climateRpc()("verdant_observations", { p_dataset: id, p_after: after, p_limit: count + 1 }) as { id: string }[];
    const more = rows.length > count;
    const observations = rows.slice(0, count);
    return dataResponse({ datasetVersion: id, observations, nextCursor: more ? observations.at(-1)!.id : null });
  } catch { return unavailable(); }
}
