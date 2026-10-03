import { z } from "zod";

export const API_VERSION = "1.0.0";
export const deliveryLimits = { maxDays: 31, maxCells: 10_000, maxRequestBytes: 16_384, maxResponseBytes: 1_000_000 } as const;
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const affineSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
const extensions = z.record(z.string(), z.unknown());

export const sourceSchema = z.object({
  sha256: sha256Schema, url: z.url().optional(), doi: z.string().optional(),
  member_path: z.string().optional(), license: z.string().optional(),
}).passthrough();
export const datasetSchema = z.object({
  id: idSchema, dataset_key: z.string(), title: z.string(), content_sha256: sha256Schema,
  source_manifest: z.array(sourceSchema).min(1), transform_version: z.string(),
  data_class: z.enum(["observation", "interpolated_observation", "forecast", "simulation", "published_aggregate"]),
  variables: z.record(z.string(), z.string()), temporal_resolution: z.string(),
  spatial_support: extensions, bbox: bboxSchema.nullable().optional(),
  period_start: z.iso.date(), period_end: z.iso.date(), license: z.string(), attribution: z.string(),
  access_level: z.enum(["demo", "paid", "restricted"]), metadata: extensions,
  status: z.enum(["staging", "published", "retired"]).optional(),
  published_at: z.string().nullable().optional(), created_at: z.string().optional(),
}).passthrough();
export type Dataset = z.infer<typeof datasetSchema>;
export const observationSchema = z.object({
  id: z.string(), dataset_version_id: idSchema, variable: z.string(), value: z.number().nullable(),
  unit: z.string(), observed_on: z.iso.date().nullable(), period_label: z.string().nullable(),
  entity_id: z.string(), dimensions: extensions, quality_flags: z.array(z.unknown()),
}).passthrough();
export const tileIndexSchema = z.object({
  id: idSchema, variable: z.string(), unit: z.string(), observed_on: z.iso.date(),
  width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256),
  crs: z.string(), transform: affineSchema, bbox: bboxSchema,
}).passthrough();
export const rasterTileSchema = tileIndexSchema.extend({
  dataset_version_id: idSchema, cells: z.array(z.number().nullable()).max(65_536),
  source_window: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
});
export type RasterTile = z.infer<typeof rasterTileSchema>;
export type TileIndex = z.infer<typeof tileIndexSchema>;
export const errorSchema = z.object({
  error: z.string(), message: z.string().optional(),
  issues: z.array(z.object({ code: z.string(), path: z.array(z.union([z.string(), z.number()])), message: z.string() }).passthrough()).optional(),
}).passthrough();
export const queryRowSchema = z.object({
  date: z.iso.date(), longitude: z.number(), latitude: z.number(), variable: z.string(),
  value: z.number().nullable(), unit: z.string(), tile: idSchema, row: z.number().int(), col: z.number().int(),
});
export type QueryRow = z.infer<typeof queryRowSchema>;
export const selectionSchema = z.object({ datasetVersion: idSchema, tileIds: z.array(idSchema), rowCount: z.number().int().positive() });
export const resolutionSchema = z.object({
  available: z.boolean(), reason: z.enum(["available", "coverage_unavailable", "request_too_large", "no_cell_centers", "unsupported_grid"]),
  selection: selectionSchema.nullable(),
  acquisitionEnabled: z.boolean().describe("True when POST /api/v1/data/requests can acquire this missing coverage from the source."),
});
export const manifestSchema = z.object({
  datasetVersion: idSchema, datasetContentSha256: sha256Schema, requestSha256: sha256Schema,
  transformVersion: z.string(), queryVersion: z.literal("native-cell-centers-v1"),
  dataClass: z.string(), crs: z.literal("EPSG:4326"), missingPolicy: z.literal("preserve"),
  spatialSelection: z.literal("cell_center_in_bbox_west_south_inclusive_east_north_exclusive"),
  rowCount: z.number().int(), sourceManifest: z.array(sourceSchema), license: z.string(), attribution: z.string(),
  dataSha256: sha256Schema.describe("SHA-256 of UTF-8 JSON.stringify(data), using returned row and field order."),
});
export const queryResultSchema = z.object({ manifest: manifestSchema, data: z.array(queryRowSchema) });

export const acquisitionStates = ["queued", "acquiring", "normalizing", "validating", "publishing", "ready", "failed"] as const;
const requestLinks = z.object({ self: z.string().optional(), query: z.string().optional(), dataset: z.string().optional() });
/** Cache hit: published coverage already satisfies the request; POST the same body to /api/v1/data/query. */
export const dataRequestReadySchema = z.object({
  status: z.literal("ready"), cache: z.literal("hit"), datasetVersion: idSchema, rowCount: z.number().int().positive(), links: requestLinks,
});
/** Cache miss accepted for acquisition, or the state of an earlier acquisition. */
export const dataRequestStatusSchema = z.object({
  id: z.uuid(), status: z.enum(acquisitionStates), cache: z.literal("miss").optional(),
  created: z.boolean().optional().describe("False when an identical in-flight or recent acquisition was reused."),
  coverageDigest: sha256Schema, target: z.record(z.string(), z.unknown()),
  datasetVersion: idSchema.nullable(), error: z.object({ reason: z.string() }).passthrough().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  job: z.object({ status: z.string(), attempts: z.number().int(), maxAttempts: z.number().int() }).nullable().optional(),
  events: z.array(z.object({ event: z.string(), details: z.record(z.string(), z.unknown()), at: z.string() })).optional(),
  links: requestLinks,
});
