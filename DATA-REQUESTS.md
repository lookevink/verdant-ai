# Agent requested climate data

Approved scope, 3 October 2026. This contract extends the five-hour demo plan. The primary product is clean climate data on demand; visualization and strategy analysis demonstrate the usefulness of the delivered data.

**Agent request → compatibility and cache check → fixed quote → MPP purchase → logged acquisition job → validated Postgres dataset → requested output.**

## Approved infrastructure

- Supabase project: `ulspzrnnwrfbgldphjpe`, named `verdant-ai`, region `us-west-1`. Verified active and healthy through the Supabase CLI.
- Read-only remote SQL inspection found no application tables and no installed PostGIS or PostGIS Raster extension. Do not assume the historical local backtests are in this hosted database. Import selected evidence deliberately.
- Raster storage: externally decoded float arrays plus grid metadata, served by an API and rendered in the browser. Native raster import is not required.
- Worker runtime: Pi coding agent using the Anthropic Claude API. User will supply the API key. Pi is installed locally as `@earendil-works/pi-coding-agent`; its installed documentation provides SDK sessions, RPC, typed tools and event subscriptions.
- Monorepo boundaries: `apps/web` and `apps/api` are separate Next.js applications. `apps/worker` is a persistent Node.js/Pi service on the target machine. Shared request schemas live in `packages/contracts`. The worker uses outbound authenticated API calls; no inbound worker port is required. The API retains database publication/payment credentials.
- These are verified inventory facts and approved choices, not a claim that acquisition, MPP, or rendering has been implemented. See README.md for current implementation status.

## What an agent requests

Keep data meaning separate from serialization. “Temperature as CSV” is insufficient without location, period, units, temporal aggregation and spatial support.

Example proposed request; the chosen source's coverage and available variables must pass preflight before quoting:

```json
{
  "variables": ["air_temperature_max"],
  "region": {"bbox": [142.30, -34.45, 142.40, -34.35], "crs": "EPSG:4326"},
  "period": {"start": "2003-01-02", "end": "2003-01-02"},
  "temporal_resolution": "daily",
  "spatial_resolution": "native",
  "units": {"air_temperature_max": "degC"},
  "data_class": "interpolated_observation",
  "format": "csv",
  "missing_policy": "preserve",
  "source_preference": "silo"
}
```

The demo supports JSON and CSV for tabular/flattened grid output, plus the existing numeric raster response for the map. Advertise only implemented representations. GeoTIFF, NetCDF, Parquet and requested resampling are extensions; reject unsupported formats clearly. Never relabel a coarse native pixel as a fine-resolution measurement.

The normalized request and quote freeze source/version selection, geometry, period, units, schema, missingness, transformation policy, output format, price, currency, deadline and resource limits. The client enforces its own maximum spend before paying. The server rejects unsupported coverage or transformations before charging.

## Hit and miss behavior

**Cache hit:** locate compatible published data, apply the declared crop/filter/serialization, and deliver under the paid entitlement. Return its actual provenance and version.

**Cache miss:** accept a bounded acquisition job after payment. Pi inspects the supported source metadata and invokes the retrieval and preprocessing tools. Deterministic validators check the result; the publisher commits a new version to Postgres and creates the requested artifact. A second compatible request reuses that version.

Cache identity includes source version, variables, support, calendar, bounds, period, units, quality and transform version. Format can be a separate derived-artifact key. Do not reuse another tenant's private uploads or restricted source data across requesters. Public reusable source data may be shared when its license permits it.

## API lifecycle

1. `POST /api/v1/data/quotes`: validate the request, check coverage/cache, return a fixed-price offer, supported output schema and expiry. This step is free and does not start expensive work.
2. `POST /api/v1/data/requests`: bind the quote ID and idempotency key to an MPP challenge. After verified payment, return `202` with a durable request ID, receipt and requester-bound access credential. A paid cache hit can return the existing artifact immediately.
3. `GET /api/v1/data/requests/{id}`: authorized state and structured progress; polling does not incur another charge.
4. `GET /api/v1/data/requests/{id}/events`: sanitized source/tool/validation events, using polling initially; an event stream is optional.
5. `GET /api/v1/data/requests/{id}/result`: authorized JSON/CSV or bounded raster output once published, including a provenance manifest and checksum.

Job states: `queued → acquiring → normalizing → validating → publishing → ready`, with explicit `failed` and `cancelled` terminal states. Payment state is separate: `unpaid`, `verified`, `refund_pending`, `refunded`. Unknown settlement requires reconciliation, not another automatic charge.

One quote purchase creates one logical job. Transactional uniqueness prevents duplicate enqueueing; worker leases prevent concurrent processing. Expired leases are recoverable, and publication is idempotent. A crash after payment must preserve the entitlement. If fulfillment fails permanently, reconcile a refund or credit according to an explicit policy; do not mark it refunded without confirmation from the payment rail.

Store `data_requests`, `request_events`, `dataset_versions`, artifact references and payment operations in Postgres. One polling worker process is enough for the demo; durable job state is required because live acquisition can outlast an HTTP request.

## Pi worker boundary

For the five-hour demo, use Pi with explicit custom tools for one known provider: `inspect_source`, `fetch_source`, `normalize_source`, `validate_output`, and `submit_manifest`. Pi chooses and coordinates supported operations; these tools execute the actual IO and transforms. No generic shell or unrestricted web browsing is needed for the initial adapter.

Create one isolated agent session per job with an explicit model, job directory, temporary resource budget and sanitized configuration. Disable discovery of personal extensions, skills and context files. Inject `ANTHROPIC_API_KEY` from server-side configuration; never place it in a prompt, browser bundle, response or event log. Keep database publication and payment credentials outside Pi's tool environment.

A separate process or working directory alone is not a security sandbox. The first worker has restricted tools and bounded provider access. If later enabling generated code or arbitrary shell commands, require a real container/sandbox with CPU, memory, wall-time and network limits before accepting untrusted requests.

Persist actual tool start/end, source URL/identifier, byte count, transformation, row/pixel count, validation checks and elapsed time. Redact credentials, signed URLs and unrelated source content. Do not expose model reasoning streams as progress logs. If BetterStack is used, query logs only through its SQL API connections.

For subprocess integration, Pi's RPC documentation distinguishes prompt acceptance from completion: consume events through `agent_settled`, handle provider errors and process exits, then validate artifacts independently. A model saying “done” never publishes a dataset by itself.

## Publication and fulfillment checks

- Source/domain and license allowed; no arbitrary URL fetches that could reach private networks.
- Download size and decompression bounded; format matches the selected adapter.
- Output conforms to declared variable, dimensions, units, calendar, geographic support and requested coverage.
- No missing-to-zero conversion, fabricated records or undocumented interpolation.
- Row/cell counts, coverage and sample source-to-output values reconciled; all transformations versioned.
- Source hash, normalized hash, attribution, quality flags and request identity recorded.
- Publish atomically only after checks pass. Persist a failed job and its reason otherwise.
- Deliver a manifest with actual data version, schema, units, missingness, coverage, source references, transform version, artifact checksum and payment/job references.

## Revised demo and five hour priorities

Lead with the theme **build something agents want**: an agent asks for clean climate data in its preferred format and gets it without installing geospatial tools, downloading a whole archive, or reconciling units locally.

1. Request one already normalized dataset and show quick delivery.
2. Request one supported new date/region not yet in the cache. Show its price and actual MPP test purchase.
3. Show the real Pi job retrieving, normalizing, validating and publishing data.
4. Download CSV, open the same data in the map, then reuse it on a second request.
5. Open the prebuilt observed-program comparison to demonstrate downstream use. Do not imply the newly acquired weather identifies new causal treatment effects.

Budget: 20 minutes infrastructure/credential checks; 40 minutes schema/import/cache-hit API; 60 minutes one-provider Pi acquisition and validators; 65 minutes request-centered UI, map and existing comparison; 40 minutes payment integration; 35 minutes verification and rehearsal. Spike payment compatibility in the first 20 minutes. This totals five hours and is aggressive.

Cut conversational strategy-builder breadth and decorative analytics before cutting the working acquisition path. Reuse the established source-specific economics and keep one scenario input if necessary. Add no second provider until request → acquisition → validation → DB → requested format works.

If the provider is unreachable, show a labeled cached replay or failed acquisition; do not represent local file copying as a new external retrieval. If the Claude key or MPP setup is missing, complete independent data/UI work and keep the corresponding feature explicitly blocked.
