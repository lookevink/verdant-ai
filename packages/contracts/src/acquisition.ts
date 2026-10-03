import { createHash } from "node:crypto";
import { z } from "zod";
import { dataRequestSchema, type DataRequest } from "./index";
import { sourceIds, variableSchema, variableUnits, type SourceId, type Variable } from "./variables";
import { bboxSchema, deliveryLimits, type Dataset } from "./responses";

/** A source grid in a top-down, west-to-east frame on EPSG:4326: cell (col,row) spans west+col·r … north−row·r. */
export type GridSpec = { west: number; north: number; resolution: number; width: number; height: number };
type VariableSpec = { sourceVariable: string; plausible: readonly [number, number] };
export type SourceSpec = {
  title: string; provider: string; product: string; license: string; attribution: string; url: string;
  grid: GridSpec; firstDate: string; latencyDays: number;
  /** Where the source has data; auto selection uses it, and acquisitions outside it are rejected. */
  coverage: readonly [number, number, number, number];
  variables: Partial<Record<Variable, VariableSpec>>;
  transformVersion: string;
};
const temperature = (sourceVariable: string, low: number, high: number) => ({ sourceVariable, plausible: [low, high] as const });

export const sourceSpecs = {
  silo: {
    title: "SILO", provider: "Queensland Government", product: "SILO daily gridded surfaces (Official, GeoTIFF)",
    license: "CC-BY-4.0", attribution: "Queensland Government SILO; interpolated Bureau of Meteorology and other observations.",
    url: "https://www.longpaddock.qld.gov.au/silo/gridded-data/",
    grid: { west: 111.975, north: -9.975, resolution: 0.05, width: 841, height: 681 }, firstDate: "1889-01-01", latencyDays: 1,
    coverage: [111.975, -44.025, 154.025, -9.975],
    variables: { air_temperature_max: temperature("max_temp", -20, 60), air_temperature_min: temperature("min_temp", -30, 45),
      precipitation_amount: { sourceVariable: "daily_rain", plausible: [0, 1500] } },
    transformVersion: "verdant-silo-daily-geotiff-v1",
  },
  nclimgrid: {
    title: "NOAA nClimGrid-Daily", provider: "NOAA National Centers for Environmental Information", product: "nClimGrid-Daily v1.0.0, 1/24° contiguous US (NetCDF, AWS Open Data)",
    license: "No restrictions (US Government work)", attribution: "NOAA NCEI nClimGrid-Daily (Durre et al. 2022), doi:10.25921/c4gt-r169.",
    url: "https://www.ncei.noaa.gov/products/land-based-station/nclimgrid-daily",
    // Cell edges from the file's centre coordinates (−124.6875…, 24.5625…; step 1/24). The file stores rows south to north.
    grid: { west: -124.6875 - 1 / 48, north: 49.375, resolution: 1 / 24, width: 1385, height: 596 }, firstDate: "1951-01-01", latencyDays: 4,
    coverage: [-124.6875 - 1 / 48, 24.5625 - 1 / 48, -67, 49.375],
    variables: { air_temperature_max: temperature("tmax", -50, 60), air_temperature_min: temperature("tmin", -60, 45),
      precipitation_amount: { sourceVariable: "prcp", plausible: [0, 1500] } },
    transformVersion: "verdant-nclimgrid-daily-netcdf-v1",
  },
  cpc: {
    title: "NOAA CPC", provider: "NOAA Climate Prediction Center (via NOAA PSL)", product: "CPC Global Unified Temperature and Precipitation, 0.5° daily",
    license: "Public domain (US Government work)", attribution: "CPC Global Unified Temperature/Precipitation data provided by the NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov",
    url: "https://psl.noaa.gov/data/gridded/data.cpc.globaltemp.html",
    // Native longitudes run 0–360°E; acquisition addresses them in a −180–180 frame and maps columns back.
    grid: { west: -180, north: 90, resolution: 0.5, width: 720, height: 360 }, firstDate: "1979-01-01", latencyDays: 2,
    coverage: [-180, -90, 180, 90],
    variables: { air_temperature_max: temperature("tmax", -90, 60), air_temperature_min: temperature("tmin", -95, 50),
      precipitation_amount: { sourceVariable: "precip", plausible: [0, 2000] } },
    transformVersion: "verdant-cpc-daily-opendap-v1",
  },
} as const satisfies Partial<Record<SourceId, SourceSpec>>;
export type AcquirableSource = keyof typeof sourceSpecs;
/** Finest first: auto selection takes the first source whose coverage contains the request. */
export const sourcePriority: readonly AcquirableSource[] = ["silo", "nclimgrid", "cpc"];
const specOf = (source: AcquirableSource): SourceSpec => sourceSpecs[source];

/** Windows snap outward to 1° blocks so nearby requests reuse one acquisition. */
const BLOCK_DEGREES = 1;
export const acquisitionLimits = { maxDays: deliveryLimits.maxDays, maxTileSide: 256, maxStoredCells: 250_000 } as const;

export const acquisitionTargetSchema = z.object({
  source: z.enum(sourceIds), variable: variableSchema, sourceVariable: z.string().regex(/^[a-z_]{1,32}$/), unit: z.string(),
  period: z.object({ start: z.iso.date(), end: z.iso.date() }).strict(),
  window: z.object({ col: z.number().int().min(0), row: z.number().int().min(0),
    width: z.number().int().min(1).max(acquisitionLimits.maxTileSide), height: z.number().int().min(1).max(acquisitionLimits.maxTileSide) }).strict(),
  bbox: bboxSchema,
  transformVersion: z.string().regex(/^verdant-[a-z0-9-]+-v\d+$/),
}).strict();
export type AcquisitionTarget = z.infer<typeof acquisitionTargetSchema>;
export type AcquisitionRejection = "outside_source_coverage" | "request_too_large" | "no_cell_centers" | "dataset_version_pinned" | "variable_unavailable";
export type AcquisitionPlan = { ok: true; target: AcquisitionTarget; coverageDigest: string; days: number; storedCells: number }
  | { ok: false; reason: AcquisitionRejection; message: string };

const round9 = (v: number) => Math.round(v * 1e9) / 1e9;
const DAY = 86_400_000;
export function dateRange(start: string, end: string) {
  const first = Date.parse(start), days = (Date.parse(end) - first) / DAY + 1;
  return Array.from({ length: days }, (_, i) => new Date(first + i * DAY).toISOString().slice(0, 10));
}
/** Cell edges from the grid origin; the same rounding the query uses for contains() checks. */
export function windowBbox(window: AcquisitionTarget["window"], grid: GridSpec): [number, number, number, number] {
  const { west, north, resolution: r } = grid;
  return [round9(west + window.col * r), round9(north - (window.row + window.height) * r),
    round9(west + (window.col + window.width) * r), round9(north - window.row * r)];
}
export const gridOf = (target: Pick<AcquisitionTarget, "source">) => specOf(target.source as AcquirableSource).grid;
const containsBox = (outer: readonly number[], inner: readonly number[]) =>
  outer[0]! <= inner[0]! && outer[1]! <= inner[1]! && outer[2]! >= inner[2]! && outer[3]! >= inner[3]!;

/** The source a request is acquired from: the explicit preference, else the finest source covering its bounds. */
export function preferredSource(request: DataRequest): AcquirableSource | null {
  const variable = request.variables[0]!;
  if (request.source_preference !== "auto")
    return request.source_preference in sourceSpecs ? request.source_preference as AcquirableSource : null;
  return sourcePriority.find(s => specOf(s).variables[variable] && containsBox(specOf(s).coverage, request.region.bbox)) ?? null;
}
/** Source of a published dataset, from its key prefix (silo-…, cpc-…, nclimgrid-…). */
export function datasetSource(dataset: Pick<Dataset, "dataset_key">): SourceId | null {
  return sourceIds.find(s => dataset.dataset_key.startsWith(`${s}-`)) ?? null;
}

/** Deterministically map a validated request that missed the cache onto one source acquisition target. */
export function planAcquisition(input: DataRequest, now = new Date()): AcquisitionPlan {
  const request = dataRequestSchema.parse(input);
  const reject = (reason: AcquisitionRejection, message: string) => ({ ok: false as const, reason, message });
  if (request.dataset_version) return reject("dataset_version_pinned", "A pinned dataset version cannot be produced by a new acquisition. Omit dataset_version.");
  const variable = request.variables[0]!;
  const source = preferredSource(request);
  if (!source) return reject("outside_source_coverage", request.source_preference === "auto"
    ? "No supported source covers these bounds for this variable." : `Source ${request.source_preference} cannot be acquired.`);
  const spec = specOf(source), variableSpec = spec.variables[variable];
  if (!variableSpec) return reject("variable_unavailable", `${spec.title} does not provide ${variable}.`);
  const latest = new Date(now.getTime() - spec.latencyDays * DAY).toISOString().slice(0, 10);
  if (request.period.start < spec.firstDate || request.period.end > latest)
    return reject("outside_source_coverage", `${spec.title} daily grids cover ${spec.firstDate} to ${latest}.`);
  const days = dateRange(request.period.start, request.period.end).length;
  if (days > acquisitionLimits.maxDays) return reject("request_too_large", `At most ${acquisitionLimits.maxDays} days per request.`);
  const grid = spec.grid, { west: gw, north: gn, resolution: r, width: gridWidth, height: gridHeight } = grid;
  const [west, south, east, north] = request.region.bbox;
  if (!containsBox(spec.coverage, request.region.bbox))
    return reject("outside_source_coverage", `${spec.title} covers ${spec.coverage.join(",")} (west,south,east,north).`);
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
  if (cols * rows === 0) return reject("no_cell_centers", `No native ${r}° cell center falls inside the requested bounds.`);
  if (cols * rows * days > deliveryLimits.maxCells) return reject("request_too_large", `At most ${deliveryLimits.maxCells} cells per request.`);
  const block = Math.max(1, Math.round(BLOCK_DEGREES / r));
  const snap = (start: number, end: number, limit: number) => {
    const s = Math.floor(start / block) * block, e = Math.min(Math.ceil(end / block) * block, limit);
    return e - s <= acquisitionLimits.maxTileSide ? [s, e] as const : [start, end] as const;
  };
  let [c0, c1] = snap(col0, col1, gridWidth), [r0, r1] = snap(row0, row1, gridHeight);
  if ((c1 - c0) * (r1 - r0) * days > acquisitionLimits.maxStoredCells) [c0, c1, r0, r1] = [col0, col1, row0, row1];
  if (c1 - c0 > acquisitionLimits.maxTileSide || r1 - r0 > acquisitionLimits.maxTileSide)
    return reject("request_too_large", `Each side of the region is limited to ${acquisitionLimits.maxTileSide} native cells.`);
  const window = { col: c0, row: r0, width: c1 - c0, height: r1 - r0 };
  const target = acquisitionTargetSchema.parse({ source, variable, sourceVariable: variableSpec.sourceVariable, unit: variableUnits[variable],
    period: { start: request.period.start, end: request.period.end }, window, bbox: windowBbox(window, grid), transformVersion: spec.transformVersion });
  return { ok: true, target, coverageDigest: coverageDigest(target), days, storedCells: window.width * window.height * days };
}

/** Key order is fixed by the schema; format and output options never change the acquired data. */
export function coverageDigest(target: AcquisitionTarget) {
  const t = acquisitionTargetSchema.parse(target);
  return createHash("sha256").update(JSON.stringify([t.source, t.variable, t.sourceVariable, t.unit, t.period.start, t.period.end,
    t.window.col, t.window.row, t.window.width, t.window.height, t.transformVersion])).digest("hex");
}

/** SILO GeoTIFF specifics shared with the worker. */
export const siloGrid = {
  ...sourceSpecs.silo.grid, nodata: -32767,
  // Files before the mid-1950s mark ocean as -3276.8 (scaled int16 -32768) while declaring -32767.
  // Either way the ocean mask is exactly this many cells in every year checked (1889–2026).
  legacyNodata: -3276.8, oceanCells: 290_758,
  firstDate: sourceSpecs.silo.firstDate, bucket: "https://s3-ap-southeast-2.amazonaws.com/silo-open-data",
} as const;
