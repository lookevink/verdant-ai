import { API_VERSION, deliveryLimits } from "./responses";
import { variableUnits } from "./variables";
export const capabilities = {
  apiVersion: API_VERSION,
  features: { catalog: true, observations: true, raster: true, validation: true, coverageResolution: true,
    directQuery: true, mcp: true, acquisition: true, quotes: false, paidRequests: true, asyncDelivery: true },
  query: { sources: ["silo", "nclimgrid", "cpc"], variables: Object.keys(variableUnits), dataClasses: ["interpolated_observation"],
    crs: ["EPSG:4326"], temporalResolutions: ["daily"], spatialResolutions: ["native"],
    units: Object.fromEntries(Object.entries(variableUnits).map(([v, u]) => [v, [u]])), formats: ["json", "csv"], defaultFormat: "json", delivery: "inline",
    missingPolicy: "preserve", access: "public", limits: deliveryLimits,
    spatialSelection: "Cell centers within west/south inclusive, east/north exclusive bounds. One covering tile per date; no resampling.",
  },
  acquisition: { endpoint: "/api/v1/data/requests", mcpTool: "request_data", access: "mpp", payment: "MPP charge per new acquisition (Stripe); published and already-running data is free",
    sources: [
      { id: "silo", name: "SILO (Queensland Government)", coverage: "Australia", resolutionDegrees: 0.05, firstDate: "1889-01-01", latencyDays: 1 },
      { id: "nclimgrid", name: "NOAA nClimGrid-Daily", coverage: "Contiguous United States", resolutionDegrees: 1 / 24, firstDate: "1951-01-01", latencyDays: 4 },
      { id: "cpc", name: "NOAA CPC Global Unified", coverage: "Global land", resolutionDegrees: 0.5, firstDate: "1979-01-01", latencyDays: 2 },
    ],
    variables: Object.keys(variableUnits), maxDays: deliveryLimits.maxDays,
    states: ["queued", "acquiring", "normalizing", "validating", "publishing", "ready", "failed"],
    description: "A cache miss is planned onto the finest source covering the bounds (or source_preference), snapped to 1° blocks of native cells, acquired by a Pi agent with Claude through bounded tools, validated cell by cell against the source bytes, and published as an immutable public version that direct queries then serve. Each source keeps its own day definition; sources are never mixed in one version. Failed paid acquisitions are refunded." },
  links: { openapi: "https://api.verdant-ai.com/api/v1/openapi.json", mcp: "https://api.verdant-ai.com/mcp",
    catalog: "https://api.verdant-ai.com/api/v1/datasets" },
} as const;
