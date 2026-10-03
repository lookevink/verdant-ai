import { createHash } from "node:crypto";
import { z } from "zod";
import { dataRequestSchema, type DataRequest } from "./index";
import { bboxSchema, deliveryLimits } from "./responses";

/** SILO daily 0.05° grids, EPSG:4326, published as GeoTIFFs at s3://silo-open-data/Official/daily. */
export const siloGrid = {
  west: 111.975, north: -9.975, resolution: 0.05, width: 841, height: 681, nodata: -32767,
  // Files before the mid-1950s mark ocean as -3276.8 (scaled int16 -32768) while declaring -32767.
  // Either way the ocean mask is exactly this many cells in every year checked (1889–2026).
  legacyNodata: -3276.8, oceanCells: 290_758,
  firstDate: "1889-01-01", bucket: "https://s3-ap-southeast-2.amazonaws.com/silo-open-data",
} as const;
export const siloVariables = {
  air_temperature_max: { sourceVariable: "max_temp", unit: "degC", plausible: [-20, 60] },
} as const;
export const siloLicense = { license: "CC-BY-4.0",
  attribution: "Queensland Government SILO; interpolated Bureau of Meteorology and other observations." } as const;
export const ACQUISITION_TRANSFORM_VERSION = "verdant-silo-daily-geotiff-v1";
/** Windows snap outward to 1° blocks so nearby requests reuse one acquisition. */
const BLOCK_CELLS = 20;
export const acquisitionLimits = { maxDays: deliveryLimits.maxDays, maxTileSide: 256, maxStoredCells: 250_000 } as const;

export const acquisitionTargetSchema = z.object({
  source: z.literal("silo"), variable: z.literal("air_temperature_max"), sourceVariable: z.literal("max_temp"), unit: z.literal("degC"),
  period: z.object({ start: z.iso.date(), end: z.iso.date() }).strict(),
  window: z.object({ col: z.number().int().min(0), row: z.number().int().min(0),
    width: z.number().int().min(1).max(acquisitionLimits.maxTileSide), height: z.number().int().min(1).max(acquisitionLimits.maxTileSide) }).strict(),
  bbox: bboxSchema,
  transformVersion: z.literal(ACQUISITION_TRANSFORM_VERSION),
}).strict();
export type AcquisitionTarget = z.infer<typeof acquisitionTargetSchema>;
export type AcquisitionRejection = "outside_source_coverage" | "request_too_large" | "no_cell_centers" | "dataset_version_pinned";
export type AcquisitionPlan = { ok: true; target: AcquisitionTarget; coverageDigest: string; days: number; storedCells: number }
  | { ok: false; reason: AcquisitionRejection; message: string };

const round9 = (v: number) => Math.round(v * 1e9) / 1e9;
const DAY = 86_400_000;
export function dateRange(start: string, end: string) {
  const first = Date.parse(start), days = (Date.parse(end) - first) / DAY + 1;
  return Array.from({ length: days }, (_, i) => new Date(first + i * DAY).toISOString().slice(0, 10));
}
/** Cell edges from the grid origin; the same rounding the query uses for contains() checks. */
export function windowBbox(w: AcquisitionTarget["window"]): [number, number, number, number] {
  const { west, north, resolution: r } = siloGrid;
  return [round9(west + w.col * r), round9(north - (w.row + w.height) * r), round9(west + (w.col + w.width) * r), round9(north - w.row * r)];
}
function snap(start: number, end: number, limit: number) {
  const s = Math.floor(start / BLOCK_CELLS) * BLOCK_CELLS, e = Math.min(Math.ceil(end / BLOCK_CELLS) * BLOCK_CELLS, limit);
  return e - s <= acquisitionLimits.maxTileSide ? [s, e] as const : [start, end] as const;
}

/** Deterministically map a validated request that missed the cache onto one SILO acquisition target. */
export function planAcquisition(input: DataRequest, now = new Date()): AcquisitionPlan {
  const request = dataRequestSchema.parse(input);
  const reject = (reason: AcquisitionRejection, message: string) => ({ ok: false as const, reason, message });
  if (request.dataset_version) return reject("dataset_version_pinned", "A pinned dataset version cannot be produced by a new acquisition. Omit dataset_version.");
  // SILO publishes each day's grid after the day ends in Australia; yesterday (UTC) is the newest date accepted.
  const latest = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
  if (request.period.start < siloGrid.firstDate || request.period.end > latest)
    return reject("outside_source_coverage", `SILO daily grids cover ${siloGrid.firstDate} to ${latest}.`);
  const days = dateRange(request.period.start, request.period.end).length;
  if (days > acquisitionLimits.maxDays) return reject("request_too_large", `At most ${acquisitionLimits.maxDays} days per request.`);
  const { west: gw, north: gn, resolution: r, width: gridWidth, height: gridHeight } = siloGrid;
  const [west, south, east, north] = request.region.bbox;
  const extent = windowBbox({ col: 0, row: 0, width: gridWidth, height: gridHeight });
  if (west < extent[0] || south < extent[1] || east > extent[2] || north > extent[3])
    return reject("outside_source_coverage", `SILO covers ${extent.join(",")} (west,south,east,north).`);
  // The smallest whole-cell window whose edges contain the requested bounds.
  let col0 = Math.max(0, Math.floor((west - gw) / r)), col1 = Math.min(gridWidth, Math.ceil((east - gw) / r));
  let row0 = Math.max(0, Math.floor((gn - north) / r)), row1 = Math.min(gridHeight, Math.ceil((gn - south) / r));
  // Division rounding must never leave a requested edge outside the rounded window edges.
  while (col0 > 0 && round9(gw + col0 * r) > west) col0--;
  while (col1 < gridWidth && round9(gw + col1 * r) < east) col1++;
  while (row0 > 0 && round9(gn - row0 * r) < north) row0--;
  while (row1 < gridHeight && round9(gn - row1 * r) > south) row1++;
  // Same selection rule as the query: centers west/south inclusive, east/north exclusive.
  let cols = 0, rows = 0;
  for (let c = col0; c < col1; c++) { const x = round9(gw + (c + 0.5) * r); if (x >= west && x < east) cols++; }
  for (let i = row0; i < row1; i++) { const y = round9(gn - (i + 0.5) * r); if (y >= south && y < north) rows++; }
  if (cols * rows === 0) return reject("no_cell_centers", "No native 0.05° cell center falls inside the requested bounds.");
  if (cols * rows * days > deliveryLimits.maxCells) return reject("request_too_large", `At most ${deliveryLimits.maxCells} cells per request.`);
  let [c0, c1] = snap(col0, col1, gridWidth), [r0, r1] = snap(row0, row1, gridHeight);
  if ((c1 - c0) * (r1 - r0) * days > acquisitionLimits.maxStoredCells) [c0, c1, r0, r1] = [col0, col1, row0, row1];
  if (c1 - c0 > acquisitionLimits.maxTileSide || r1 - r0 > acquisitionLimits.maxTileSide)
    return reject("request_too_large", `Each side of the region is limited to ${acquisitionLimits.maxTileSide} native cells.`);
  const window = { col: c0, row: r0, width: c1 - c0, height: r1 - r0 };
  const target = acquisitionTargetSchema.parse({ source: "silo", variable: "air_temperature_max", sourceVariable: "max_temp", unit: "degC",
    period: { start: request.period.start, end: request.period.end }, window, bbox: windowBbox(window), transformVersion: ACQUISITION_TRANSFORM_VERSION });
  return { ok: true, target, coverageDigest: coverageDigest(target), days, storedCells: window.width * window.height * days };
}

/** Key order is fixed by the schema; format and output options never change the acquired data. */
export function coverageDigest(target: AcquisitionTarget) {
  const t = acquisitionTargetSchema.parse(target);
  return createHash("sha256").update(JSON.stringify([t.source, t.variable, t.sourceVariable, t.unit, t.period.start, t.period.end,
    t.window.col, t.window.row, t.window.width, t.window.height, t.transformVersion])).digest("hex");
}
