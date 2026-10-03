# Verdant AI

Clean climate data for agents, with requested formats, provenance and MPP access.

## Direct data API and documentation

The API at `https://api.verdant-ai.com` exposes a generated OpenAPI 3.1 contract at `/api/v1/openapi.json`. Shared Zod schemas in `packages/contracts` define runtime validation and the generated reference. `pnpm docs:generate` updates `docs/openapi.json`; `pnpm docs:check` detects drift and runs as part of `pnpm test`.

- `GET /api/v1/capabilities`: supported query dimensions, delivery limits and actual feature availability.
- `GET /api/v1/datasets` and `GET /api/v1/datasets/{id}`: published catalog, coverage and provenance.
- `POST /api/v1/data/resolve`: check complete compatible published coverage without purchasing or acquiring anything.
- `POST /api/v1/data/query`: return data **directly in the response**, defaulting to JSON `{manifest,data}`. CSV is an alternate response representation, with provenance links and digest headers. A download is optional client behavior, not a required delivery step.
- `/mcp`: eight read-only data tools using the same query implementation; discovery at `/.well-known/mcp`.

Direct queries currently support SILO daily maximum temperature in Celsius on a native EPSG:4326 grid. The imported demo covers 1 January 2003 near Mildura. Queries are bounded to 31 days, 10,000 cells and 1 MB, require complete coverage, and support an immutable `dataset_version` pin. Study observations and native raster endpoints remain available separately. No endpoint silently converts a cache miss into paid acquisition.

Mintlify lives in the monorepo's `docs/` directory with `docs.json`, guides and generated OpenAPI. Configure the existing Mintlify site's repository as `lookevink/verdant-ai`, branch `main`, path `/docs`; see [deployment setup](docs/README.md). Hosted Mintlify deployment still requires connection to the user's existing workspace. Its built-in search MCP covers documentation; the API's own MCP supplies live data tools.

Run `pnpm api:verify <origin>` to check the hosted contract, direct JSON/CSV checksums, real-data coverage and MCP/REST parity. The website request form queries real data inline and separately offers syntax-only validation.

## Monorepo

| Workspace | Runtime | Responsibility |
|---|---|---|
| `apps/web` | Next.js, port 3000 | Website, maps and strategy results |
| `apps/api` | Next.js, port 3001 | Request contracts, MPP verification and job submission |
| `apps/worker` | Persistent Node.js on the target machine | Pull jobs, run Pi/Claude acquisition and publish validated data |
| `packages/contracts` | TypeScript/Zod | Shared data contracts |
| `packages/queue` | Supabase pgmq + Postgres RPCs | Claims, leases, retries and idempotent enqueueing |

The web server proxies `/api/*` to the API. External agents call the API directly. The worker pulls from Supabase pgmq over outbound HTTPS; no inbound worker port is required. The trusted worker supervisor has Supabase publication credentials. When Pi execution is added, give its subprocess an explicit environment allowlist: **never inherit Supabase or payment secrets into Pi**. A separate process is not a security sandbox.

## Environment profiles

Use Node.js 22+ and pnpm 11.24.0. Root `.env.local` is the sandbox source of truth; `.env.production` is the production source of truth. Existing `.env.prod` is retained as a legacy input. The generated app files are ignored by Git and have mode `0600`.

```sh
pnpm install --frozen-lockfile
pnpm env:sync
pnpm dev
pnpm worker:sandbox
```

Edit root profiles, then run `pnpm env:sync` again. Only public Supabase URL/publishable key reach the browser. Supabase secret keys are restricted to API and trusted worker; Stripe credentials are restricted to API. Claude credentials are restricted to the worker.

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
pnpm test
pnpm build
pnpm worker:check
pnpm queue:smoke sandbox
pnpm queue:smoke production
pnpm services:smoke sandbox
pnpm services:smoke production
```

Queue smoke tests use unique job IDs in dedicated `:smoke` queues and retain their records/archives for inspection. They verify atomic concurrent claims, idempotency, stale-worker rejection, lease recovery, lane isolation and retry limits. Service smoke tests start an API on port 3101, enqueue an authenticated diagnostic, run the real worker once, and check completion. They leave the diagnostic record for inspection. Both refuse live payment profiles.

The worker currently consumes **diagnostic jobs only** and verifies pgmq/Supabase access. It does not yet acquire climate data or invoke Pi. `worker:check` reports missing Claude configuration separately. Completed queue records currently have no retention policy; add bounded retention before sustained use.

## Vercel

Target team: **Kevin Personal Projects** (`lookevinks-projects`). Two projects: `verdant-ai-web` with root `apps/web`, and `verdant-ai-api` with root `apps/api`. Include files outside the root directory so shared packages are available. The worker stays on the target machine.

```sh
pnpm vercel:sync
```

This script links/configures these projects, obtains the API's assigned domain, updates the local production origin, and uploads per-service environment values. Production uses `.env.production`; development/preview use `.env.local`. Secrets are uploaded through stdin and marked sensitive in production/preview. It does not deploy. Both projects are linked to GitHub `main` and deploy automatically on push. Production environment values are present and the deployed database reads and website proxy were verified on 3 October 2026. Environment changes apply to the next deployment; some environment-management actions may still require project-admin access.

For paired previews, deploy the API preview first, then set the web preview's `API_ORIGIN` to that exact deployment URL before building. The sync script deliberately excludes the localhost origin from hosted previews. Vercel web builds fail if no API origin is configured. If preview deployment protection is enabled, configure authenticated server-to-server access before testing the proxy.

## MPP with Stripe

MPP is the HTTP payment protocol; Stripe handles the payment. The sandbox endpoint is `GET /api/v1/payments/probe`, priced at **$0.50 in test funds**. It verifies a Stripe SPT and queues a diagnostic job. It does not sell climate data. It returns 404 in live mode and 503 until credentials and a sandbox business profile are present.

A dedicated, temporary Stripe sandbox has been created under CLI profile `verdant`; it expires **10 October 2026** unless claimed. Its temporary key has been copied into both test-mode environment profiles. The key cannot currently access the MPP business-profile API (HTTP 403). Claim it, log into the claimed sandbox, and create its Stripe business profile:

```sh
stripe sandbox claim --project-name verdant
stripe login --project-name verdant
pnpm stripe:sync
pnpm vercel:sync
```

`stripe:sync` reads only the Verdant CLI profile, retrieves the `profile_test_` ID, and updates both test-mode profiles without printing keys. If profile lookup is denied, complete Stripe account/profile setup first.

To test on a deployed production URL, **keep server-side `PAYMENT_MODE=test` and sandbox Stripe credentials**, then run the pinned validator:

```sh
pnpm --filter @verdant/api exec mppx validate https://YOUR-API/api/v1/payments/probe
```

Verify `/api/health` reports `paymentMode: test` first. This exercises HTTP 402 → test payment → receipt → queue → worker on deployed infrastructure. No client-controlled switch can enable sandbox mode. The sandbox probe is disabled in live mode. Do not run the validator against live payment endpoints without an explicit spending budget: the validator can move real funds.

Verified receipts and pgmq enqueueing commit together in Postgres; retrying the same credential recovers a saved receipt. There remains a crash window between Stripe settlement and saving the receipt. This test-only endpoint is **not** a production payment ledger or an exactly-once settlement guarantee. Durable reconciliation, quote binding, requester entitlements, refunds and a working acquisition handler are required before enabling paid data requests.

References: [Stripe MPP](https://docs.stripe.com/payments/machine/mpp), [Stripe sandboxes](https://docs.stripe.com/sandboxes).

## Current scope

Implemented: the versioned read/query contract, generated OpenAPI, Mintlify monorepo documentation, direct JSON/CSV responses, read-only MCP, environment distribution, pgmq queue/leases/retries, authenticated diagnostic enqueue/status, worker polling for diagnostics, Stripe MPP sandbox probe code, and verification scripts. Live queue/Supabase checks work in both profiles, including API → queue → worker completion. Pi needs `ANTHROPIC_API_KEY` and `PI_MODEL`; the payment roundtrip needs a claimed Stripe sandbox and MPP business profile. These prerequisites are separate from hosting the public demo API.

`POST /api/v1/data/requests` currently returns 503 and never charges or enqueues work. Climate schemas, handoff import, catalog/observation/raster APIs and transactional publication RPCs are implemented; see [database setup and verification](supabase/README.md). Pi execution, source acquisition, map rendering, backtests, quote lifecycle HTTP routes and paid data fulfillment are still pending.

## Build specifications

- [Five-hour plan](BUILD-PLAN.md)
- [Data requests and worker contract](DATA-REQUESTS.md)
- [Platform roadmap](PLATFORM-ROADMAP.md)

BetterStack log queries must use SQL API connections. Browser/UI log queries are prohibited.
