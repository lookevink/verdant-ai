import { z } from "zod";
import { dataRequestSchema, exampleRequest } from "./index";
import { API_VERSION, datasetSchema, errorSchema, observationSchema, rasterTileSchema, tileIndexSchema,
  resolutionSchema, queryResultSchema, affineSchema, idSchema, dataRequestReadySchema, dataRequestStatusSchema } from "./responses";

export const toolInputs = {
  empty: z.object({}).strict(),
  dataset: z.object({ id: idSchema }).strict(),
  query: dataRequestSchema.safeExtend({ format: z.literal("json").default("json") }),
  page: z.object({ id: idSchema, limit: z.number().int().min(1).max(1000).default(100), after: z.string().max(256).optional() }).strict(),
  sample: z.object({ id: idSchema, tile: idSchema, row: z.number().int().min(0), col: z.number().int().min(0) }).strict(),
  requestId: z.object({ id: z.uuid() }).strict(),
};

const schema = (value: z.ZodType, input = false) => {
  const { $schema: _dialect, ...json } = z.toJSONSchema(value, { target: "draft-2020-12", io: input ? "input" : "output" });
  return json;
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({ description, content: { "application/json": { schema: ref(name) } } });
const error = (description: string) => json("Error", description);
const body = { required: true, description: "A bounded climate query. JSON is the default representation. The response contains data directly; no download or acquisition job is required.",
  content: { "application/json": { schema: ref("DataRequest"), example: { ...exampleRequest, format: "json" } } } };
const id = { name: "id", in: "path", required: true, description: "Immutable dataset version ID returned by the catalog.", schema: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" } };
const pagination = [
  { name: "limit", in: "query", description: "Maximum records in this page. Response size is also capped at 1 MB.", schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 } },
  { name: "after", in: "query", description: "Opaque nextCursor from the preceding page. Omit for the first page; stop when nextCursor is null.", schema: { type: "string", maxLength: 256 } },
];
const readErrors = { "400": error("Invalid query parameters."), "404": error("Unknown, unpublished, or not publicly accessible."), "413": error("Response exceeds the 1 MB bound; narrow the query."), "503": error("Data service unavailable. Retry with exponential backoff.") };
const writeErrors = { "400": error("Empty, malformed JSON, or unreadable body."), "413": error("Request or response exceeds bounds."), "415": error("Content-Type must be application/json."), "422": error("Invalid contract, incompatible coverage, or unsupported query."), "503": error("Data service unavailable.") };

export const operationDescriptions = {
  getCapabilities: "Discover the implemented variables, sources, representations, limits and feature availability. This does not check current source coverage.",
  listDatasets: "List published catalog metadata. Published public datasets can be read without payment. Restricted datasets are omitted.",
  getDataset: "Inspect an immutable dataset version, including units, actual coverage, source hashes, license, attribution and spatial support.",
  resolveData: "Check complete published coverage for a structured climate query. Returns the selected immutable version and row count, or an explicit unavailable reason; acquisitionEnabled reports whether POST /api/v1/data/requests can acquire a miss. Does not acquire data or charge.",
  queryData: "Return climate data directly in the response, with provenance. JSON includes a manifest and data array; CSV returns rows with version, digest and metadata-link headers. Only published public data is admitted. No charging, acquisition or missing-to-zero conversion.",
  requestData: "Get data that may not be published yet. Published coverage returns ready (free). An identical acquisition already running returns its request (free). Otherwise the request is acquired from the source for a fixed MPP price: the first call returns a payment challenge, and the paid retry returns a request ID and receipt. Poll the request until ready, then query. Requests outside source coverage are rejected before any charge.",
  getDataRequest: "Acquisition state (queued → acquiring → normalizing → validating → publishing → ready, or failed), attempts, sanitized tool and validation events, payments, and the published datasetVersion once ready. Failed paid acquisitions are refunded. Polling never charges.",
} as const;

export const openapi = {
  openapi: "3.1.0",
  info: { title: "Verdant Climate Data API", version: API_VERSION,
    description: "Versioned climate data with preserved meaning. Discover → inspect → resolve → query. Small published-data queries return values directly, with explicit units, spatial support, missingness and provenance. Reading published data requires no credentials. Missing coverage is acquired from the source on request through /api/v1/data/requests, paid per acquisition with MPP. Consult capabilities before planning a workflow." },
  servers: [{ url: "https://api.verdant-ai.com", description: "Production" }],
  security: [],
  tags: [{ name: "Discovery" }, { name: "Queries" }, { name: "Observations" }, { name: "Raster" }, { name: "Service" }],
  paths: {
    "/api/health": { get: { operationId: "getHealth", tags: ["Service"], summary: "Check process health",
      description: "Process/configuration status only. This does not verify database or source-provider connectivity.", responses: { "200": json("Health", "Process is running.") } } },
    "/api/v1/capabilities": { get: { operationId: "getCapabilities", tags: ["Discovery"], summary: "Discover capabilities", description: operationDescriptions.getCapabilities,
      responses: { "200": json("Capabilities", "Implemented capabilities and hard query limits.") } } },
    "/api/v1/datasets": { get: { operationId: "listDatasets", tags: ["Discovery"], summary: "List datasets", description: operationDescriptions.listDatasets,
      responses: { "200": json("Catalog", "Published dataset metadata."), "413": readErrors["413"], "503": readErrors["503"] } } },
    "/api/v1/datasets/{id}": { get: { operationId: "getDataset", tags: ["Discovery"], summary: "Inspect a dataset", description: operationDescriptions.getDataset, parameters: [id],
      responses: { "200": json("DatasetDetail", "Dataset version metadata."), ...readErrors } } },
    "/api/v1/data/validate": { post: { operationId: "validateDataRequest", tags: ["Queries"], summary: "Validate query structure",
      description: "Validate shape, calendar dates and ordered bounds only. A valid request is not a coverage guarantee, quote or purchase. Bounds must be west < east and south < north; period start must not follow end. These cross-field constraints are enforced at runtime.",
      requestBody: body, responses: { "200": json("Validation", "Valid request structure, with defaults applied."), ...writeErrors } } },
    "/api/v1/data/resolve": { post: { operationId: "resolveData", tags: ["Queries"], summary: "Resolve coverage", description: operationDescriptions.resolveData,
      requestBody: body, responses: { "200": json("Resolution", "Coverage checked. available=false is a successful preflight with an unavailable reason."), ...writeErrors } } },
    "/api/v1/data/query": { post: { operationId: "queryData", tags: ["Queries"], summary: "Query data directly", description: operationDescriptions.queryData,
      requestBody: body, responses: { "200": { description: "Complete bounded result, returned inline. Native cell centers are selected west/south inclusive and east/north exclusive; dates are inclusive. No Content-Disposition attachment is set.",
        headers: {
          "Content-Digest": { description: "SHA-256 of exact response bytes, formatted sha-256=:BASE64:.", schema: { type: "string" } },
          "Verdant-Dataset-Version": { description: "Immutable version used.", schema: { type: "string" } },
          "Verdant-Request-SHA256": { description: "SHA-256 of the validated, normalized request.", schema: { type: "string" } },
          Link: { description: "Dataset metadata URL with rel=describedby. Includes source references, license and attribution for CSV clients.", schema: { type: "string" } },
        }, content: { "application/json": { schema: ref("QueryResult") }, "text/csv": { schema: { type: "string" },
          example: "date,longitude,latitude,variable,value,unit,tile,row,col\r\n\"2003-01-01\",\"142.35\",\"-34.4\",\"air_temperature_max\",\"30.5\",\"degC\",\"mildura\",\"48\",\"47\"\r\n" } } }, ...writeErrors } } },
    "/api/v1/datasets/{id}/observations": { get: { operationId: "listObservations", tags: ["Observations"], summary: "Read observations", parameters: [id, ...pagination],
      description: "Read public observations in stable ID order. Native dates and season labels remain distinct; a missing value is null, not zero. Follow nextCursor until null.",
      responses: { "200": json("ObservationPage", "One observation page."), ...readErrors } } },
    "/api/v1/layers/{id}": { get: { operationId: "getRasterLayer", tags: ["Raster"], summary: "Read a raster index or tile", parameters: [id, ...pagination,
      { name: "tile", in: "query", description: "Omit to list tile metadata. Supply an ID from that list to fetch its bounded row-major cells.", schema: { type: "string", maxLength: 128 } }],
      description: "Only public data. Cells are top-down row-major: cells[row * width + col]. NULL is preserved. Affine [a,b,c,d,e,f] maps pixel centers to x=a*(col+.5)+b*(row+.5)+c and y=d*(col+.5)+e*(row+.5)+f.",
      responses: { "200": { description: "Paginated index without tile; complete bounded tile when tile is supplied.", content: { "application/json": { schema: { oneOf: [ref("TilePage"), ref("TileDetail")] } } } }, ...readErrors } } },
    "/api/v1/layers/{id}/sample": { get: { operationId: "sampleRaster", tags: ["Raster"], summary: "Read one raster cell", parameters: [id,
      { name: "tile", in: "query", required: true, schema: { type: "string" }, description: "Tile ID from the layer index." },
      ...["row", "col"].map(name => ({ name, in: "query", required: true, schema: { type: "integer", minimum: 0 }, description: "Zero-based index within this tile." }))],
      description: "Return one native cell and its spatial metadata. A null value means missing, and its unit and evidence class do not change.",
      responses: { "200": json("PixelSample", "One native raster cell."), ...readErrors } } },
    "/api/v1/data/requests": { post: { operationId: "requestData", tags: ["Queries"], summary: "Request data, acquiring a cache miss", description: operationDescriptions.requestData +
      " Over HTTP the challenge is a 402 with WWW-Authenticate: Payment (Stripe shared payment token); retry with Authorization: Payment and keep the same credential for any retry. Then POST the same body to /api/v1/data/query once ready.",
      security: [{}, { mppPayment: [] }, { bearerToken: [] }], requestBody: { ...body, description: "The same request body as /api/v1/data/query. Format does not change what is acquired." },
      responses: { "200": json("DataRequestReady", "Cache hit: published coverage already satisfies the request (free)."),
        "202": { description: "Acquisition queued after payment, or an identical running acquisition (free). Poll the Location URL.",
          headers: { Location: { description: "Status URL for this acquisition.", schema: { type: "string" } }, "Retry-After": { description: "Suggested polling delay in seconds.", schema: { type: "integer" } },
            "Payment-Receipt": { description: "MPP receipt when this call paid (or recovered a payment).", schema: { type: "string" } } },
          content: { "application/json": { schema: ref("DataRequestStatus") } } },
        "402": { description: "Payment required for a new acquisition. application/problem+json with the challenge in WWW-Authenticate.",
          headers: { "WWW-Authenticate": { description: "MPP Payment challenge (method stripe, intent charge).", schema: { type: "string" } } } },
        "502": error("payment_or_fulfillment_failed: retry with the same credential to recover without a second charge."),
        "413": error("request_too_large: more than 31 days, 10,000 cells, or 256 cells per side."),
        "422": error("Invalid contract, or an acquisition rejection: outside_source_coverage, no_cell_centers, dataset_version_pinned."),
        "400": writeErrors["400"], "415": writeErrors["415"], "503": writeErrors["503"] } } },
    "/api/v1/data/requests/{id}": { get: { operationId: "getDataRequest", tags: ["Queries"], summary: "Poll an acquisition",
      description: operationDescriptions.getDataRequest,
      parameters: [{ name: "id", in: "path", required: true, description: "Request ID from POST /api/v1/data/requests.", schema: { type: "string", format: "uuid" } }],
      responses: { "200": { description: "Current acquisition state.", headers: { "Retry-After": { description: "Present while processing.", schema: { type: "integer" } } },
        content: { "application/json": { schema: ref("DataRequestStatus") } } }, "404": error("request_not_found"), "503": readErrors["503"] } } },
  },
  components: { schemas: {
    DataRequest: { ...schema(dataRequestSchema, true), description: "Data meaning is independent of representation and delivery. JSON (default) and CSV are returned inline. Bbox order: west,south,east,north; no antimeridian crossing. Date bounds inclusive; at most 31 days and 10,000 cells; actual coverage must pass resolve. dataset_version pins reproducibility." },
    Dataset: schema(datasetSchema), Error: schema(errorSchema), Observation: schema(observationSchema), RasterTile: schema(rasterTileSchema),
    Resolution: schema(resolutionSchema), QueryResult: schema(queryResultSchema),
    DataRequestReady: schema(dataRequestReadySchema), DataRequestStatus: schema(dataRequestStatusSchema),
    Catalog: { type: "object", required: ["datasets"], properties: { datasets: { type: "array", items: ref("Dataset") } } },
    DatasetDetail: { type: "object", required: ["dataset"], properties: { dataset: ref("Dataset") } },
    ObservationPage: { type: "object", required: ["datasetVersion", "observations", "nextCursor"], properties: {
      datasetVersion: { type: "string" }, observations: { type: "array", items: ref("Observation") }, nextCursor: { type: ["string", "null"] } } },
    TilePage: { type: "object", required: ["dataset", "tiles", "nextCursor"], properties: {
      dataset: ref("Dataset"), tiles: { type: "array", items: schema(tileIndexSchema) }, nextCursor: { type: ["string", "null"] } } },
    TileDetail: { type: "object", required: ["datasetVersion", "tile"], properties: { datasetVersion: { type: "string" }, tile: ref("RasterTile") } },
    PixelSample: schema(z.object({ datasetVersion: z.string(), tile: z.string(), row: z.number().int(), col: z.number().int(),
      value: z.number().nullable(), unit: z.string(), variable: z.string(), date: z.iso.date(), crs: z.string(), transform: affineSchema })),
    Validation: { type: "object", required: ["valid", "request", "coverageVerified", "acquisitionEnabled", "message"], properties: {
      valid: { const: true }, request: ref("DataRequest"), coverageVerified: { const: false }, acquisitionEnabled: { type: "boolean" }, message: { type: "string" } } },
    Health: schema(z.object({ service: z.literal("verdant-api"), status: z.literal("ok"), scope: z.literal("process"),
      environment: z.string(), paymentMode: z.string(), capabilities: z.object({ requestValidation: z.boolean(), acquisition: z.boolean(), payments: z.boolean() }) })),
    Capabilities: schema(z.object({ apiVersion: z.string(), features: z.record(z.string(), z.boolean()),
      query: z.object({ sources: z.array(z.string()), variables: z.array(z.string()), dataClasses: z.array(z.string()), crs: z.array(z.string()),
        temporalResolutions: z.array(z.string()), spatialResolutions: z.array(z.string()), units: z.record(z.string(), z.array(z.string())),
        formats: z.array(z.string()), defaultFormat: z.string(), delivery: z.string(), missingPolicy: z.string(), access: z.string(),
        limits: z.record(z.string(), z.number()), spatialSelection: z.string() }),
      acquisition: z.object({ endpoint: z.string(), mcpTool: z.string(), access: z.string(), payment: z.string(),
        sources: z.array(z.object({ id: z.string(), name: z.string(), coverage: z.string(), resolutionDegrees: z.number(), firstDate: z.string(), latencyDays: z.number() })),
        variables: z.array(z.string()), maxDays: z.number(), states: z.array(z.string()), description: z.string() }),
      links: z.record(z.string(), z.url()) })),
  },
  securitySchemes: {
    mppPayment: { type: "http", scheme: "payment", description: "Machine Payments Protocol credential for a new acquisition, issued in response to a 402 challenge." },
    bearerToken: { type: "http", scheme: "bearer", description: "Operator token: queues acquisitions without payment." },
  },
  },
} as const;
