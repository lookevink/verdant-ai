import { API_VERSION, deliveryLimits } from "./responses";
export const capabilities = {
  apiVersion: API_VERSION,
  features: { catalog: true, observations: true, raster: true, validation: true, coverageResolution: true,
    directQuery: true, mcp: true, acquisition: true, quotes: false, paidRequests: false, asyncDelivery: true },
  query: { sources: ["silo"], variables: ["air_temperature_max"], dataClasses: ["interpolated_observation"],
    crs: ["EPSG:4326"], temporalResolutions: ["daily"], spatialResolutions: ["native"],
    units: { air_temperature_max: ["degC"] }, formats: ["json", "csv"], defaultFormat: "json", delivery: "inline",
    missingPolicy: "preserve", access: "public_demo", limits: deliveryLimits,
    spatialSelection: "Cell centers within west/south inclusive, east/north exclusive bounds. One covering tile per date; no resampling.",
  },
  acquisition: { endpoint: "/api/v1/data/requests", access: "bearer_token", sources: ["silo"], variables: ["air_temperature_max"],
    firstDate: "1889-01-01", latestDate: "yesterday (UTC)", maxDays: deliveryLimits.maxDays,
    states: ["queued", "acquiring", "normalizing", "validating", "publishing", "ready", "failed"],
    description: "A cache miss is planned onto a native SILO grid window (snapped to 1° blocks), acquired by a Pi agent with Claude through bounded tools, independently validated, and published as an immutable public demo version that direct queries then serve." },
  links: { openapi: "https://api.verdant-ai.com/api/v1/openapi.json", mcp: "https://api.verdant-ai.com/mcp",
    catalog: "https://api.verdant-ai.com/api/v1/datasets" },
} as const;
