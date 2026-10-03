import { createHash } from "node:crypto";
import { dataRequestSchema, deliveryLimits, queryResultSchema, type DataRequest, type Dataset, type TileIndex, type RasterTile, type QueryRow } from "@verdant/contracts";

export type DataStore = {
  catalog(): Promise<Dataset[]>;
  tiles(dataset: string): Promise<TileIndex[]>;
  tile(dataset: string, tile: string): Promise<RasterTile>;
};
type Reason = "coverage_unavailable" | "request_too_large" | "no_cell_centers" | "unsupported_grid";
export class QueryError extends Error {
  constructor(public readonly code: Reason, public readonly status = 422) { super(code); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const contains = (outer: number[], inner: number[]) => outer[0]! <= inner[0]! && outer[1]! <= inner[1]! && outer[2]! >= inner[2]! && outer[3]! >= inner[3]!;
const coordinate = (v: number) => Math.round(v * 1e9) / 1e9;

function pixels(tile: TileIndex, request: DataRequest) {
  const [a, b, c, d, e, f] = tile.transform;
  if (tile.crs !== "EPSG:4326" || b !== 0 || d !== 0 || a <= 0 || e >= 0) throw new QueryError("unsupported_grid");
  const extent = [c, f + tile.height * e, c + tile.width * a, f];
  if (extent.some((value, i) => Math.abs(value - tile.bbox[i]!) > 1e-8) || !contains(extent.map(coordinate), request.region.bbox))
    throw new QueryError("unsupported_grid");
  const [west, south, east, north] = request.region.bbox;
  const found: { row: number; col: number; longitude: number; latitude: number }[] = [];
  for (let row = 0; row < tile.height; row++) {
    const latitude = coordinate(f + (row + 0.5) * e);
    if (latitude < south || latitude >= north) continue;
    for (let col = 0; col < tile.width; col++) {
      const longitude = coordinate(c + (col + 0.5) * a);
      if (longitude >= west && longitude < east) found.push({ row, col, longitude, latitude });
    }
  }
  return found;
}

async function plan(input: DataRequest, store: DataStore) {
  const request = dataRequestSchema.parse(input);
  const start = Date.parse(request.period.start), end = Date.parse(request.period.end);
  const days = (end - start) / 86_400_000 + 1;
  if (days > deliveryLimits.maxDays) throw new QueryError("request_too_large", 413);
  const dates = Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const candidates = (await store.catalog()).filter(d =>
    d.access_level === "demo" && d.status === "published" &&
    (!request.dataset_version || d.id === request.dataset_version) &&
    d.dataset_key.startsWith("silo-") && d.data_class === request.data_class &&
    d.temporal_resolution === request.temporal_resolution && d.variables.air_temperature_max === request.units.air_temperature_max &&
    d.spatial_support.crs === request.region.crs && d.bbox && contains(d.bbox, request.region.bbox) &&
    d.period_start <= request.period.start && d.period_end >= request.period.end
  ).sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "") || a.id.localeCompare(b.id));
  let lastReason: Reason = "coverage_unavailable";
  for (const dataset of candidates) {
    const index = await store.tiles(dataset.id);
    const selected: { tile: TileIndex; pixels: ReturnType<typeof pixels> }[] = [];
    let count = 0;
    for (const date of dates) {
      // This first adapter requires one covering tile per date. It never silently returns a partial region.
      const tile = index.filter(t => t.observed_on === date && t.variable === "air_temperature_max" && t.unit === "degC" && contains(t.bbox, request.region.bbox))
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!tile) break;
      let selectedPixels;
      try { selectedPixels = pixels(tile, request); }
      catch (error) { if (!(error instanceof QueryError)) throw error; lastReason = error.code; break; }
      if (selectedPixels.length === 0) { lastReason = "no_cell_centers"; break; }
      count += selectedPixels.length;
      if (count > deliveryLimits.maxCells) throw new QueryError("request_too_large", 413);
      selected.push({ tile, pixels: selectedPixels });
    }
    if (selected.length === dates.length) return { dataset, request, selected, count };
  }
  throw new QueryError(lastReason);
}

export async function resolveData(request: DataRequest, store: DataStore) {
  try {
    const result = await plan(request, store);
    return { available: true, reason: "available" as const, selection: {
      datasetVersion: result.dataset.id, tileIds: result.selected.map(s => s.tile.id), rowCount: result.count,
    }, acquisitionEnabled: false as const };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { available: false, reason: error.code, selection: null, acquisitionEnabled: false as const };
  }
}

export async function queryData(request: DataRequest, store: DataStore) {
  const planResult = await plan(request, store);
  const { dataset, selected } = planResult;
  const data: QueryRow[] = [];
  for (const selection of selected) {
    const tile = await store.tile(dataset.id, selection.tile.id);
    if (tile.dataset_version_id !== dataset.id || tile.id !== selection.tile.id ||
      tile.cells.length !== tile.width * tile.height || tile.observed_on !== selection.tile.observed_on ||
      tile.width !== selection.tile.width || tile.height !== selection.tile.height ||
      tile.variable !== selection.tile.variable || tile.unit !== selection.tile.unit || tile.crs !== selection.tile.crs ||
      JSON.stringify(tile.transform) !== JSON.stringify(selection.tile.transform)) throw new Error("Published tile does not match its index.");
    for (const pixel of selection.pixels) data.push({ date: tile.observed_on, longitude: pixel.longitude, latitude: pixel.latitude,
      variable: tile.variable, value: tile.cells[pixel.row * tile.width + pixel.col]!, unit: tile.unit,
      tile: tile.id, row: pixel.row, col: pixel.col });
  }
  return queryResultSchema.parse({ manifest: {
    datasetVersion: dataset.id, datasetContentSha256: dataset.content_sha256,
    requestSha256: hash(JSON.stringify(planResult.request)), transformVersion: dataset.transform_version,
    queryVersion: "native-cell-centers-v1", dataClass: dataset.data_class, crs: "EPSG:4326", missingPolicy: "preserve",
    spatialSelection: "cell_center_in_bbox_west_south_inclusive_east_north_exclusive", rowCount: data.length,
    sourceManifest: dataset.source_manifest, license: dataset.license, attribution: dataset.attribution,
    dataSha256: hash(JSON.stringify(data)),
  }, data });
}

export function csvData(data: QueryRow[]) {
  const columns = ["date", "longitude", "latitude", "variable", "value", "unit", "tile", "row", "col"] as const;
  const cell = (v: unknown) => v === null ? "" : `"${String(v).replace(/"/g, '""')}"`;
  return columns.join(",") + "\r\n" + data.map(row => columns.map(k => cell(row[k])).join(",")).join("\r\n") + "\r\n";
}
export function responseDigest(body: string) { return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`; }
