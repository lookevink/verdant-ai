# Verdant AI

Clean climate data for agents, with requested formats, provenance and MPP access.

## Monorepo

| Workspace | Runtime | Responsibility |
|---|---|---|
| `apps/web` | Next.js, port 3000 | Website, data requests, maps and strategy results |
| `apps/api` | Next.js route handlers, port 3001 | Public data contracts, payment verification, jobs and publication |
| `apps/worker` | Node.js on the target machine | Pi/Claude acquisition, parsing, validation and upload |
| `packages/contracts` | Shared TypeScript and Zod | Request validation and job states |

The web server proxies `/api/*` to the API. External agents call the API directly. The worker will use outbound authenticated requests to claim jobs, emit events and submit outputs; it requires no public inbound port. The API owns database publication and payment credentials. Pi receives narrowly scoped acquisition tools, not the database admin key. A separate process is not a security sandbox.

## Development

Use Node.js 22 or newer and pnpm 11.24.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. The request form calls the separate API through the web proxy. Run either app alone with `pnpm dev:web` or `pnpm dev:api`.

Copy each app's `.env.example` to its own `.env.local` when configuring it. The root environment template is only a pointer; environments are deliberately separate. The development proxy defaults to `http://127.0.0.1:3001`.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm worker:check
```

Worker configuration checks return a nonzero exit status when credentials are missing, and print only missing variable names. They do not call Claude, acquire files or verify external credentials. Validate a JSON request file on the worker with `pnpm --filter @verdant/worker validate /absolute/path/request.json`.

For production, deploy the two Next.js apps separately and set the web's `API_ORIGIN` before building. `pnpm --filter @verdant/web start` and `pnpm --filter @verdant/api start` run their production servers. Deploy the worker to the chosen target machine as a persistent service once its job loop is implemented. An HTTPS API URL is required outside local development.

## Current implementation

Implemented: workspace structure, a request form, API health endpoint, bounded request-validation endpoint, shared schema/tests and worker configuration/request validation commands.

Not yet implemented: database tables/import, worker job claims and leases, Pi execution, source acquisition, publication/upload, map rendering, backtests and MPP payment verification. Validation success confirms request structure only, not source coverage, availability or purchase. The API health response reports process health, not database readiness.

Supabase target: `ulspzrnnwrfbgldphjpe`. No remote database changes were made by this scaffold.

## Build specifications

- [Five-hour plan](BUILD-PLAN.md)
- [Data requests and worker contract](DATA-REQUESTS.md)
- [Platform roadmap](PLATFORM-ROADMAP.md)

Put the Claude API key in `apps/worker/.env.local` as `ANTHROPIC_API_KEY`. Keep it on the worker machine. The `VERDANT_WORKER_TOKEN` will authenticate the worker to the API; the worker authentication endpoints are not implemented yet. Never put secret keys in `NEXT_PUBLIC_` variables.

BetterStack log queries must use SQL API connections. Browser/UI log queries are prohibited.
