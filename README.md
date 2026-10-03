# Verdant AI

Clean climate data for agents, with requested formats, provenance and MPP access.

## Direct data API and documentation

The API at `https://api.verdant-ai.com` exposes a generated OpenAPI 3.1 contract at `/api/v1/openapi.json`. Shared Zod schemas in `packages/contracts` define runtime validation and the generated reference. `pnpm docs:generate` updates `docs/openapi.json`; `pnpm docs:check` detects drift and runs as part of `pnpm test`.

- `GET /api/v1/capabilities`: supported query dimensions, delivery limits and actual feature availability.
- `GET /api/v1/datasets` and `GET /api/v1/datasets/{id}`: published catalog, coverage and provenance.
- `POST /api/v1/data/resolve`: check complete compatible published coverage without purchasing or acquiring anything.
- `POST /api/v1/data/query`: return data **directly in the response**, defaulting to JSON `{manifest,data}`. CSV is an alternate response representation, with provenance links and digest headers. A download is optional client behavior, not a required delivery step.
- `POST /api/v1/data/requests`: cache hit → `200` with the version to query. Cache miss → a bounded SILO acquisition is queued (`202`, bearer token required) and `GET /api/v1/data/requests/{id}` reports progress until the new version is `ready`.
- `/mcp`: eight read-only data tools using the same query implementation; discovery at `/.well-known/mcp`.

Direct queries currently support SILO daily maximum temperature in Celsius on a native EPSG:4326 grid. The imported demo covers 1 January 2003 near Mildura; any other date from 1889 to yesterday and any region on the SILO grid can be acquired on request. Queries are bounded to 31 days, 10,000 cells and 1 MB, require complete coverage, and support an immutable `dataset_version` pin. Study observations and native raster endpoints remain available separately. No endpoint converts a cache miss into a paid acquisition; queueing one requires the API bearer token until MPP-paid requests exist.

Mintlify lives in the monorepo's `docs/` directory with `docs.json`, guides and generated OpenAPI. Configure the existing Mintlify site's repository as `lookevink/verdant-ai`, branch `main`, path `/docs`; see [deployment setup](docs/README.md). Hosted Mintlify deployment still requires connection to the user's existing workspace. Its built-in search MCP covers documentation; the API's own MCP supplies live data tools.

Run `pnpm api:verify <origin>` to check the hosted contract, direct JSON/CSV checksums, real-data coverage and MCP/REST parity. The website request form queries real data inline and separately offers syntax-only validation.

## Monorepo

| Workspace | Runtime | Responsibility |
|---|---|---|
| `apps/web` | Next.js, port 3000 | Website, maps and strategy results |
| `apps/api` | Next.js, port 3001 | Request contracts, MPP verification and job submission |
| `apps/worker` | Persistent Node.js on the target machine | Pull pgmq jobs, run Pi/Claude acquisition, verify and publish data |
| `packages/contracts` | TypeScript/Zod | Shared data contracts |
| `packages/queue` | Supabase pgmq + Postgres RPCs | Claims, leases, retries and idempotent enqueueing |

The web server proxies `/api/*` to the API. External agents call the API directly. The worker pulls from Supabase pgmq over outbound HTTPS; no inbound worker port is required. The trusted worker supervisor has Supabase publication credentials. Pi runs as a child process with an explicit environment allowlist (model credential only): **Supabase, payment and API secrets never reach Pi**. A separate process is not a security sandbox, so Pi gets five narrow acquisition tools and no shell, file or web tools.

### Acquisition on a cache miss

1. The API resolves the request against published data. A miss is planned onto one SILO target (dates + native grid window snapped to 1° blocks) and, in one transaction, recorded and enqueued on the `acquisition` pgmq lane. Identical targets share one acquisition.
2. The worker claims it under a 90 s lease (renewed every 20 s) and starts Pi with `PI_MODEL` (default `anthropic/claude-opus-5-5`). Pi calls `inspect_source → fetch_source → normalize_source → validate_output → submit_manifest`; those tools do all IO and transforms deterministically against the public SILO S3 bucket.
3. The supervisor re-runs validation (period, provenance, cell-for-cell reconciliation with source bytes, dimensions, finite/plausible values, the fixed 290,758-cell ocean mask as the only nodata), builds a content-addressed dataset version, and publishes version + tiles + `ready` + queue acknowledgement atomically with a final lease check.
4. Failures retry twice with backoff; unfixable source problems end the request immediately. Progress and sanitized tool events are visible at `GET /api/v1/data/requests/{id}`.

The published content depends only on the source bytes, so Pi and the scripted test agent produce the same dataset version for the same target. Job directories live under `.work/worker` (`WORKER_DATA_DIR`); source GeoTIFFs are deleted after publication, receipts and manifests are kept.

## Environment profiles

Use Node.js 22+ and pnpm 11.24.0. Root `.env.local` is the sandbox source of truth; `.env.production` is the production source of truth. Existing `.env.prod` is retained as a legacy input. The generated app files are ignored by Git and have mode `0600`.

```sh
pnpm install --frozen-lockfile
pnpm env:sync
pnpm dev
pnpm worker:sandbox
```

Edit root profiles, then run `pnpm env:sync` again. Only public Supabase URL/publishable key reach the browser. Supabase secret keys are restricted to API and trusted worker; Stripe credentials are restricted to API. Claude credentials (`ANTHROPIC_API_KEY`, `PI_MODEL`, and `ANTHROPIC_WORKSPACE_ID` for organization-level keys that are not scoped to a workspace) are restricted to the worker, which passes only them to Pi.

| Setting | Sandbox | Production profile |
|---|---|---|
| Profile | `.env.local` | `.env.production` |
| `VERDANT_ENV` | `sandbox` | `production` |
| `PAYMENT_MODE` currently | `test` | `test` |
| Queue namespace | `verdant:sandbox:test` | `verdant:production:test` |
| Supabase | `ulspzrnnwrfbgldphjpe` | Same project |
| pgmq | Sandbox queues | Separate production queues |

These are separate queue/configuration profiles, **not physically isolated databases**. Climate tables use environment keys and composite foreign keys; queue names also include payment mode. The API selects its environment from server configuration.

`pnpm worker:production` explicitly loads the production profile. Use `scripts/run-profile.mjs` for production builds/runs because Next.js normally loads `.env.local` ahead of `.env.production`. `pnpm build` builds using local settings; `pnpm build:production` uses the explicit production profile. Set production `API_ORIGIN` before building the web. Direct worker invocations default to `.env.local`.

## Verification

```sh
pnpm typecheck
pnpm test                      # includes migrations + SQL suites on in-process Postgres (pnpm db:test)
pnpm acquisition:e2e --scripted  # API → pgmq → worker → publish → query, scripted agent, in-memory DB
pnpm acquisition:e2e             # same with Pi + Claude (worker production profile credentials)
pnpm acquisition:e2e --remote    # Pi against hosted Supabase, sandbox partition, random uncached dates
VERDANT_NETWORK_TESTS=1 pnpm --filter @verdant/worker test  # reproduces the published Mildura tile from SILO
pnpm build
pnpm worker:check
pnpm queue:smoke sandbox
pnpm queue:smoke production
pnpm services:smoke sandbox
pnpm services:smoke production
```

Queue smoke tests use unique job IDs in dedicated `:smoke` queues and retain their records/archives for inspection. They verify atomic concurrent claims, idempotency, stale-worker rejection, lease recovery, lane isolation and retry limits. Service smoke tests start an API on port 3101, enqueue an authenticated diagnostic, run the real worker once, and check completion. They leave the diagnostic record for inspection. Both refuse live payment profiles.

The worker consumes diagnostic probes and acquisitions, one job at a time. Without a model credential it serves probes only and logs `acquisition_disabled`. `worker:check` reports the Pi model and credential status. `pnpm --filter @verdant/worker acquire <request.json>` runs one acquisition locally without a database and writes the would-be publication for inspection. Completed queue records currently have no retention policy; add bounded retention before sustained use.

`scripts/local-db.ts` runs every migration on in-process Postgres (PGlite with pgmq's SQL, pinned and hash-checked) and serves a PostgREST-compatible `/rest/v1/rpc` endpoint, so the API and worker can run without Docker or a Supabase login. It approximates Supabase; hosted checks remain authoritative.

## Vercel

Target team: **Kevin Personal Projects** (`lookevinks-projects`). Two projects: `verdant-ai-web` with root `apps/web`, and `verdant-ai-api` with root `apps/api`. Include files outside the root directory so shared packages are available. The worker stays on the target machine.

```sh
pnpm vercel:sync
```

This script links/configures these projects, obtains the API's assigned domain, updates the local production origin, and uploads per-service environment values. Production uses `.env.production`; development/preview use `.env.local`. Secrets are uploaded through stdin and marked sensitive in production/preview. It does not deploy. Both projects are linked to GitHub `main` and deploy automatically on push. Production environment values are present and the deployed database reads and website proxy were verified on 3 October 2026. Environment changes apply to the next deployment; some environment-management actions may still require project-admin access.

For paired previews, deploy the API preview first, then set the web preview's `API_ORIGIN` to that exact deployment URL before building. The sync script deliberately excludes the localhost origin from hosted previews. Vercel web builds fail if no API origin is configured. If preview deployment protection is enabled, configure authenticated server-to-server access before testing the proxy.

## MPP with Stripe

MPP is the HTTP payment protocol; Stripe handles the payment. The sandbox endpoint is `GET /api/v1/payments/probe`, priced at **$0.50 in test funds**. It verifies a Stripe SPT and queues a diagnostic job. It does not sell climate data. It returns 404 in live mode and 503 until credentials and a sandbox business profile are present.

A dedicated Stripe sandbox, `acct_1UMWhEERBvLA6kcm`, is configured under CLI profile `verdant`. On 3 October 2026, its temporary claimable key was replaced with an authorized sandbox CLI key in both local test-mode environment profiles. The CLI key expires on **1 January 2027**.

The approved parent-account profile is **Verdant AI / `@verdant_ai`**, under `acct_1QWlcUDe3K7WSdzX` (ALIVE AND HEALTHY LLC). Stripe automatically created the sandbox profile `profile_test_61VVxfHx9KMi5gkIBA6VVxfHM1SQgBts4PNNPcAh6DmC`, with handle `verdant_ai_sandbox_69160`. Local profiles and Vercel development/preview payment settings are synced.

**Verified locally on 3 October 2026:** HTTP 402 challenge, malformed-credential rejection, actual $0.50 Stripe sandbox payment (`pi_3UMZl5ERBvLA6kcm0Bn5LYQV`, `livemode=false`), HTTP 202, durable probe enqueue, and successful worker completion using the production test namespace. The pinned validator reports 15 passing checks and one discovery failure: it expects an MPP discovery document at `/openapi.json`, while the current climate API contract is served at `/api/v1/openapi.json` without the probe discovery metadata. Payment-flow success does not mean the full validator passes.

**Production deployment remains pending:** the Vercel CLI identity `kevin-sendblue` has the `DEVELOPER` role on `lookevinks-projects`; Vercel denies production environment-variable writes. An owner or a role with production environment access must apply the four payment settings and redeploy. The approved production upload was attempted but did not succeed; the public API still uses its prior configuration.

To refresh configuration, verify the CLI still targets the dedicated sandbox, then retrieve and distribute its `profile_test_` ID:

```sh
stripe whoami --project-name verdant
pnpm stripe:sync
pnpm vercel:sync
```

`stripe:sync` reads only the Verdant CLI profile, retrieves the `profile_test_` ID, and updates both test-mode profiles without printing keys. Do not select the parent account or another sandbox during CLI login. If profile lookup returns 404, complete the parent profile setup first.

To test on a deployed production URL, **keep server-side `PAYMENT_MODE=test` and sandbox Stripe credentials**, then run the pinned validator:

```sh
pnpm --filter @verdant/api exec mppx validate https://YOUR-API --endpoint GET:/api/v1/payments/probe
```

Verify `/api/health` reports `paymentMode: test` first. The validator exercises the payment endpoint; separately run the diagnostic worker and verify the returned job completes. Its discovery check still fails until the discovery route is implemented. No client-controlled switch can enable sandbox mode. The sandbox probe is disabled in live mode. Do not run the validator against live payment endpoints without an explicit spending budget: the validator can move real funds.

Verified receipts and pgmq enqueueing commit together in Postgres; retrying the same credential recovers a saved receipt. There remains a crash window between Stripe settlement and saving the receipt. This test-only endpoint is **not** a production payment ledger or an exactly-once settlement guarantee. Durable reconciliation, quote binding, requester entitlements, refunds and a working acquisition handler are required before enabling paid data requests.

References: [Stripe MPP](https://docs.stripe.com/payments/machine/mpp), [Stripe sandboxes](https://docs.stripe.com/sandboxes).

## Current scope

Implemented: the versioned read/query contract, generated OpenAPI, Mintlify monorepo documentation, direct JSON/CSV responses, read-only MCP, environment distribution, pgmq queue/leases/retries, authenticated diagnostic enqueue/status, worker polling for diagnostics and acquisitions, cache-miss acquisition with Pi, Stripe MPP sandbox probe code, and verification scripts. Live queue/Supabase checks work in both profiles, including API → queue → worker completion. Pi needs `ANTHROPIC_API_KEY` (plus `ANTHROPIC_WORKSPACE_ID` for an unscoped organization key); `PI_MODEL` defaults to `anthropic/claude-opus-5-5`. The Stripe sandbox payment roundtrip is verified locally; its public deployment requires the Vercel production environment update described above.

Cache-miss acquisition is implemented for SILO daily maximum temperature: authorized `POST /api/v1/data/requests`, pgmq queueing, the Pi worker with Claude Opus 5.5, independent validation and atomic publication. Verified 3 October 2026 locally and against the hosted sandbox partition. Climate schemas, handoff import, catalog/observation/raster APIs and transactional publication RPCs are implemented; see [database setup and verification](supabase/README.md). Map rendering, backtests, quote lifecycle HTTP routes, MPP-paid requests, more variables/sources and paid data fulfillment are still pending.

## Build specifications

- [Five-hour plan](BUILD-PLAN.md)
- [Data requests and worker contract](DATA-REQUESTS.md)
- [Platform roadmap](PLATFORM-ROADMAP.md)

BetterStack log queries must use SQL API connections. Browser/UI log queries are prohibited.

## Agent skills

Install the [Verdant backtesting skills](skills/README.md) for service-backed data discovery, forecast protection, perennial economics and nitrogen-policy replay:

```sh
npx skills add lookevink/verdant-ai --skill verdant-data-discovery verdant-forecast-backtest verdant-perennial-economics verdant-nitrogen-replay
```
