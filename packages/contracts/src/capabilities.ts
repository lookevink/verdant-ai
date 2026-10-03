import { API_VERSION, deliveryLimits } from "./responses";
export const capabilities = {
  apiVersion: API_VERSION,
  features: { catalog: true, observations: true, raster: true, validation: true, coverageResolution: true,
    directQuery: true, mcp: true, acquisition: false, quotes: false, paidRequests: false, asyncDelivery: false },
  query: { sources: ["silo"], variables: ["air_temperature_max"], dataClasses: ["interpolated_observation"],
    crs: ["EPSG:4326"], temporalResolutions: ["daily"], spatialResolutions: ["native"],
    units: { air_temperature_max: ["degC"] }, formats: ["json", "csv"], defaultFormat: "json", delivery: "inline",
    missingPolicy: "preserve", access: "public_demo", limits: deliveryLimits,
    spatialSelection: "Cell centers within west/south inclusive, east/north exclusive bounds. One covering tile per date; no resampling.",
  },
  links: { openapi: "https://api.verdant-ai.com/api/v1/openapi.json", mcp: "https://api.verdant-ai.com/mcp",
    catalog: "https://api.verdant-ai.com/api/v1/datasets" },
} as const;
