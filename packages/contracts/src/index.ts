import { z } from "zod";
import { sourceIds, variableSchema, variableUnits } from "./variables";
export * from "./variables";
export * from "./responses";
export * from "./capabilities";

const date = z.iso.date();
export const dataRequestSchema = z.object({
  variables: z.array(variableSchema).min(1).max(1),
  region: z.object({
    bbox: z.tuple([
      z.number().min(-180).max(180), z.number().min(-90).max(90),
      z.number().min(-180).max(180), z.number().min(-90).max(90),
    ]).refine(([west, south, east, north]) => west < east && south < north,
      "Bounds must be ordered west, south, east, north; antimeridian requests are not supported yet."),
    crs: z.literal("EPSG:4326"),
  }).strict(),
  period: z.object({ start: date, end: date }).strict()
    .refine(({ start, end }) => start <= end, "Start date must not follow end date."),
  temporal_resolution: z.literal("daily"),
  spatial_resolution: z.literal("native"),
  units: z.object({ air_temperature_max: z.literal("degC").optional(), air_temperature_min: z.literal("degC").optional(),
    precipitation_amount: z.literal("mm").optional() }).strict().describe("Exactly one entry, for the requested variable."),
  data_class: z.literal("interpolated_observation"),
  format: z.enum(["json", "csv"]).default("json"),
  missing_policy: z.literal("preserve"),
  source_preference: z.enum(["auto", ...sourceIds]).default("auto")
    .describe("auto picks the finest source covering the region: SILO (Australia), NOAA nClimGrid-Daily (contiguous US), NOAA CPC (global)."),
  dataset_version: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional()
    .describe("Pin an immutable published dataset version. Omit to choose a compatible public version."),
}).strict().refine(r => Object.keys(r.units).length === 1 && r.units[r.variables[0]!] === variableUnits[r.variables[0]!],
  { message: "units must name exactly the requested variable with its supported unit.", path: ["units"] });
export type DataRequest = z.infer<typeof dataRequestSchema>;

export const exampleRequest: DataRequest = {
  variables: ["air_temperature_max"],
  region: { bbox: [142.30, -34.45, 142.40, -34.35], crs: "EPSG:4326" },
  period: { start: "2003-01-01", end: "2003-01-01" },
  temporal_resolution: "daily", spatial_resolution: "native",
  units: { air_temperature_max: "degC" },
  data_class: "interpolated_observation", format: "csv",
  missing_policy: "preserve", source_preference: "silo",
};

export const jobStates = ["queued", "acquiring", "normalizing", "validating", "publishing", "ready", "failed", "cancelled"] as const;
export type JobState = typeof jobStates[number];
