import { climateRpc, demoDataset, dataResponse, unavailable } from "../../../../../src/lib/climate-data";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const tileId = params.get("tile");
  const limit = Number(params.get("limit") ?? 100), after = params.get("after") ?? "";
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || after.length > 256) return dataResponse({error:"invalid_pagination"},400);
  try {
    const dataset = await demoDataset(id);
    if (!dataset) return dataResponse({ error: "dataset_not_found_or_requires_entitlement" }, 404);
    if (!tileId) {
      const rows = await climateRpc()("verdant_raster_index", { p_dataset: id, p_after: after, p_limit: limit + 1 }) as {id:string}[];
      const tiles = rows.slice(0,limit);
      return dataResponse({dataset,tiles,nextCursor:rows.length>limit?tiles.at(-1)!.id:null});
    }
    if (tileId.length > 128) return dataResponse({ error: "invalid_tile" }, 400);
    const tile = await climateRpc()("verdant_raster_tile", { p_dataset: id, p_tile: tileId });
    return tile ? dataResponse({ datasetVersion: id, tile }) : dataResponse({ error: "tile_not_found" }, 404);
  } catch { return unavailable(); }
}
