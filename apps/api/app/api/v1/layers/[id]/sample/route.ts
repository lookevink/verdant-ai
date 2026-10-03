import { climateRpc, demoDataset, dataResponse, unavailable, type RasterTile } from "../../../../../../src/lib/climate-data";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const p = new URL(request.url).searchParams;
  const tileId = p.get("tile"), row = Number(p.get("row")), col = Number(p.get("col"));
  if (!tileId || !p.has("row") || !p.has("col") || !Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0)
    return dataResponse({ error: "tile_and_zero_based_row_col_required" }, 400);
  try {
    if (!await demoDataset(id)) return dataResponse({ error: "dataset_not_found_or_requires_entitlement" }, 404);
    const tile = await climateRpc()("verdant_raster_tile", { p_dataset: id, p_tile: tileId }) as RasterTile | null;
    if (!tile) return dataResponse({ error: "tile_not_found" }, 404);
    if (row >= tile.height || col >= tile.width) return dataResponse({ error: "pixel_out_of_bounds" }, 400);
    return dataResponse({ datasetVersion: id, tile: tileId, row, col, value: tile.cells[row * tile.width + col],
      unit: tile.unit, variable: tile.variable, date: tile.observed_on, crs: tile.crs, transform: tile.transform });
  } catch { return unavailable(); }
}
