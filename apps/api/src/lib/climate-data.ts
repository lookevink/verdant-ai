import { createDatabaseRpc } from "@verdant/queue";
import { datasetSchema, tileIndexSchema, rasterTileSchema, API_VERSION, type Dataset } from "@verdant/contracts";
export type { Dataset, RasterTile } from "@verdant/contracts";
export function climateRpc() {
  const environment = process.env.VERDANT_ENV;
  if (environment !== "sandbox" && environment !== "production") throw new Error("Explicit environment required.");
  const rpc = createDatabaseRpc();
  return (name: string, args: Record<string, unknown> = {}) => rpc(name, { p_environment: environment, ...args });
}
export async function catalog(): Promise<Dataset[]> {
  return datasetSchema.array().parse(await climateRpc()("verdant_catalog"));
}
export async function demoDataset(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return undefined;
  return (await catalog()).find(d => d.id === id && d.access_level === "demo");
}
export function dataResponse(body: unknown, status = 200) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 1_000_000) return Response.json({ error: "response_too_large" }, { status: 413 });
  return new Response(encoded, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Verdant-API-Version": API_VERSION } });
}
export function unavailable() { return dataResponse({ error: "data_service_unavailable" }, 503); }

export const dataStore = {
  catalog,
  async tiles(id: string) {
    const rows = tileIndexSchema.array().parse(await climateRpc()("verdant_raster_index", { p_dataset: id, p_limit: 1001 }));
    if (rows.length > 1000) throw new Error("Dataset exceeds query index limit.");
    return rows;
  },
  async tile(dataset: string, tile: string) {
    return rasterTileSchema.parse(await climateRpc()("verdant_raster_tile", { p_dataset: dataset, p_tile: tile }));
  },
};
