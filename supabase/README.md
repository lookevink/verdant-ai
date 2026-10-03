# Climate data and pgmq

Target: `ulspzrnnwrfbgldphjpe` (`verdant-ai`). The four migrations create the private `verdant` schema, pgmq transport, service-only RPCs and the private `verdant-artifacts` bucket. No PostGIS, pgvector, GDAL server import, or Redis is required.

## Data model

- `dataset_versions`: canonical normalized-content SHA-256, source hashes/URLs, transform version, units, coverage, licensing, access level and publication state.
- `observations`: nullable numerical values, source record dimensions, units and native date/season support.
- `raster_tiles`: bounded `real[]` cells, affine transform, EPSG CRS, source window, units and date. NULL differs from zero; NaN/infinity and incorrect array dimensions are rejected.
- `data_quotes`, `payment_operations`, `data_requests`, `request_events`, `artifacts`: frozen requests, ownership hashes, durable entitlements, processing events and result manifests.
- `analysis_runs`: reproducible inputs/results tied to a dataset version.
- `jobs`: durable job identity, retry count and fencing tokens; pgmq owns message visibility and archival. Lanes: `probe`, `data_request`, `acquisition`.
- `acquisitions`, `acquisition_events`: cache-miss acquisitions keyed by a canonical target digest (at most one live per target), their state and sanitized worker events.

Every scientific/request relation has an environment key and composite foreign keys. Sandbox and production share this database by explicit choice. A service secret is trusted across both partitions; this is application-level isolation, not separate credentials/databases. API handlers select the environment from configuration, never a query parameter. Queue namespaces additionally separate test/live payment modes.

RLS is enabled with no browser policies. `anon`/`authenticated` cannot use the private schema or the `public.verdant_*` RPCs. Only the API and trusted worker supervisor use these SECURITY INVOKER functions. Pi must not inherit their Supabase secret. Free demo endpoints explicitly require `access_level=demo`; paid/restricted data cannot use that path.

## Queue and publication contract

`packages/queue` retains `enqueue`, `claim`, `renew`, `complete`, `fail`, `get` and `health`, now backed by Supabase HTTP RPCs. Visibility/lease durations have one-second granularity. Each claim generates a new UUID; expired/stale tokens cannot acknowledge or publish. Failed attempts become visible after a delay, bounded retries become terminal, and terminal pgmq messages are archived. Short per-lane transaction advisory locks ensure consistent lock order between the job ledger and pgmq. Smoke queues end in `:smoke`; their records are retained.

The trusted API verifies settlement against the frozen quote before calling `verdant_submit_request`. That function atomically inserts payment/entitlement/event/job/message records. It cannot itself verify external Stripe settlement. `verdant_request_progress` records ordered processing stages. `verdant_publish_request` attaches the validated artifact reference, marks the request ready and acknowledges pgmq in one transaction, with a final lease check. Identical publication retries recover success; changed artifact identities are rejected. The trusted publisher must upload and verify the object before invoking publication.

`verdant_submit_acquisition` records an acquisition and enqueues it in one transaction, or returns the live (or recently failed) acquisition for the same target. `verdant_acquisition_progress` records lease-fenced, forward-only stages and events. `verdant_publish_acquisition` inserts a content-addressed `silo-*` demo version and its tiles, checks one tile per day inside the declared bounds, publishes, marks the acquisition ready and acknowledges pgmq in one transaction; an identical existing version is reused and a lost-response retry returns success. `verdant_abandon_acquisition` ends a job that retrying cannot fix. Failed attempts return the acquisition to `queued`; the last one marks it failed.

Dataset content cannot change after publication. Corrections require a new version. Raster JSON and paginated observation responses are capped at 1 MB. Catalog metadata is free; arbitrary paid extraction remains disabled until its quote/acquisition/payment integration exists.

## Run locally without Docker

`pnpm db:test` applies every migration to in-process Postgres (PGlite + pgmq 1.5.1's SQL, downloaded once, hash-pinned and cached in `.work/vendor`) and runs `supabase/tests/*.sql`. `pnpm db:local` keeps it running with a PostgREST-compatible `/rest/v1/rpc` endpoint for the API and worker (`--env-file <path>` writes its URL and key). This approximates Supabase roles, storage and pgmq; it is not a substitute for the hosted checks.

## Run locally with the Supabase CLI

This stack is isolated from neighboring projects: API `58321`, Postgres `58322`, shadow DB `58320`, project ID `verdant-ai`.

```sh
supabase start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
supabase db reset --local --no-seed
psql postgresql://postgres:postgres@127.0.0.1:58322/postgres -X -v ON_ERROR_STOP=1 -f supabase/tests/integration.sql
node scripts/local-queue-smoke.mjs
```

The SQL suite is for this isolated local stack. It rolls back its fixtures. Do not reset the linked remote project. Do not reset another project's stack.

## Reproduce the handoff import

The expanded production backtest import is documented in [BACKTESTS.md](BACKTESTS.md): seven perennial study families, the NWS day-two rain/frost decision cohorts, and all Ohio nitrogen policy variants, with clients that replay from public API responses.

Install the pinned Python decoding dependencies from `scripts/data/requirements.txt` in an isolated environment. The preparation command performs no network/database writes and leaves the handoff unchanged. It verifies selected files against `FILES.jsonl`, source hashes against the normalized-input manifest, all irrigation totals, SILO grid/units, and the source-to-normalized shape. It writes SQL, an import receipt and expected values under ignored `.work/`.

```sh
python scripts/data/prepare-handoff.py /path/to/agriculture-demo-2026-10-02 --environment sandbox --output .work/import/sandbox.sql
psql postgresql://postgres:postgres@127.0.0.1:58322/postgres -X -v ON_ERROR_STOP=1 -f .work/import/sandbox.sql
node scripts/data/http-smoke.mjs local
```

The import contains nine treatment-year outcomes as 27 endpoint observations plus 457 dated irrigation events, and a native 81×81 SILO crop around Mildura for 1 January 2003. It stores the approximate trial point with its qualification; no field boundary is invented. The raster is interpolated weather context, not the cause of measured treatment effects. CSIRO and SILO assets preserve CC-BY-4.0 attribution. The importer compares every stored value/metadata field before committing and safely verifies repeat imports without rewriting published versions.

## Remote deployment and verification

```sh
supabase db push --linked --project-ref ulspzrnnwrfbgldphjpe --dry-run --skip-vault
supabase db push --linked --project-ref ulspzrnnwrfbgldphjpe --skip-vault
supabase db query --linked --project-ref ulspzrnnwrfbgldphjpe --file .work/import/sandbox.sql
python scripts/data/prepare-handoff.py /path/to/agriculture-demo-2026-10-02 --environment production --output .work/import/production.sql
supabase db query --linked --project-ref ulspzrnnwrfbgldphjpe --file .work/import/production.sql
pnpm env:sync
pnpm queue:smoke sandbox
pnpm queue:smoke production
node scripts/data/http-smoke.mjs sandbox
node scripts/data/http-smoke.mjs production
```

The HTTP smoke runner starts a temporary local API on port 3102 pointed at the selected database. It verifies paginated observations, every float32 cell/mask, sample bounds and the CSIRO three-year reference. It does not claim a hosted API deployment or browser rendering. `services:smoke` also checks authenticated API enqueue → actual worker → completion.

Read APIs:

- `GET /api/v1/datasets`
- `GET /api/v1/datasets/{version}/observations?limit=100&after=...`
- `GET /api/v1/layers/{version}?limit=100&after=...` (tile metadata index)
- `GET /api/v1/layers/{version}?tile=mildura`
- `GET /api/v1/layers/{version}/sample?tile=mildura&row=40&col=40`

Next work: quote/download HTTP routes and MPP-paid requests, provider settlement reconciliation/refunds, scheduled job/archive retention, and a map consuming these actual responses.

`20261003211138_acquisitions.sql` was pushed on 3 October 2026. After it, the public key received `42501 permission denied` on every new RPC, and `pnpm acquisition:e2e --remote` (Pi + Claude Opus 5.5, sandbox partition) published and served a new version end to end.

## Verified 3 October 2026

All three migration versions match remote history. Both sandbox and production partitions contain two published datasets, 484 observations and 6,561 raster cells. Local SQL integration (including publication replay and >1,000-tile pagination), local/remote queue smoke tests, all-value HTTP checks, and actual API → pgmq → worker completion passed. Public-key calls to private data/queue RPCs returned HTTP 401. Supabase advisors returned no warnings/errors. Workspace builds, typechecks and six unit tests passed. API verification used temporary local servers connected to remote Supabase; hosted deployment and browser rendering were not performed here.
