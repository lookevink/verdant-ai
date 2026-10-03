# Verdant AI

Clean climate data for agents, with requested formats, provenance and MPP access.

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

This script links/configures these projects, obtains the API's assigned domain, updates the local production origin, and uploads per-service environment values. Production uses `.env.production`; development/preview use `.env.local`. Secrets are uploaded through stdin and marked sensitive in production/preview. It does not deploy. Both projects now exist and are linked, and development/preview uploads have completed. Production sync was partially blocked by Vercel: `kevin-sendblue` lacks permission to create production environment variables. An owner must grant project-admin access or import each generated app `.env.production` into its corresponding project, scoped to production only. Then rerun sync to reconcile values. Environment changes apply to the next deployment.

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

Implemented: environment distribution, request validation, pgmq queue/leases/retries, authenticated diagnostic enqueue/status, worker polling for diagnostics, Stripe MPP sandbox probe code, and verification scripts. Live queue/Supabase checks are working in both configuration profiles, including API → queue → worker completion. Production builds, typechecks and six tests pass. Stripe payment roundtrip and completion of Vercel production environment sync still require the external account access described above.

`POST /api/v1/data/requests` currently returns 503 and never charges or enqueues work. Climate schemas, handoff import, catalog/observation/raster APIs and transactional publication RPCs are implemented; see [database setup and verification](supabase/README.md). Pi execution, source acquisition, map rendering, backtests, quote lifecycle HTTP routes and paid data fulfillment are still pending.

## Build specifications

- [Five-hour plan](BUILD-PLAN.md)
- [Data requests and worker contract](DATA-REQUESTS.md)
- [Platform roadmap](PLATFORM-ROADMAP.md)

BetterStack log queries must use SQL API connections. Browser/UI log queries are prohibited.
