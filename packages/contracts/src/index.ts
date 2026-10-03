import { z } from "zod";

const date = z.iso.date();
export const dataRequestSchema = z.object({
  variables: z.array(z.enum(["air_temperature_max"])).min(1).max(1),
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
  units: z.object({ air_temperature_max: z.literal("degC") }).strict(),
  data_class: z.literal("interpolated_observation"),
  format: z.enum(["json", "csv"]),
  missing_policy: z.literal("preserve"),
  source_preference: z.literal("silo"),
}).strict();
export type DataRequest = z.infer<typeof dataRequestSchema>;

export const exampleRequest: DataRequest = {
  variables: ["air_temperature_max"],
  region: { bbox: [142.30, -34.45, 142.40, -34.35], crs: "EPSG:4326" },
  period: { start: "2003-01-02", end: "2003-01-02" },
  temporal_resolution: "daily", spatial_resolution: "native",
  units: { air_temperature_max: "degC" },
  data_class: "interpolated_observation", format: "csv",
  missing_policy: "preserve", source_preference: "silo",
};

export const jobStates = ["queued", "acquiring", "normalizing", "validating", "publishing", "ready", "failed", "cancelled"] as const;
export type JobState = typeof jobStates[number];
