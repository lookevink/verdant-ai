# Mintlify deployment

Connect the existing Verdant Mintlify project to `lookevink/verdant-ai`, branch `main`, documentation path `/docs` (monorepo mode). Target custom domain: `docs.verdant-ai.com`, subject to the existing workspace configuration. Do not change another project's connected repository.

Run `pnpm docs:generate` after contract changes. `pnpm docs:check` fails if the checked-in OpenAPI differs from runtime. Validate and preview with the pinned CLI: `pnpm dlx mint@4.2.981 validate` and `pnpm dlx mint@4.2.981 dev`, from this directory. The deployed API independently serves its exact compiled specification at `/api/v1/openapi.json`.

The hosted docs/Mintlify search MCP are not verified until the existing workspace is connected and the deployment completes. A repository config alone does not provision a Mintlify site. Once deployed, test its `/mcp` search server and `/openapi.json`. Verdant's data MCP is deployed with the API and tested separately.

Vendor references checked 3 October 2026: [OpenAPI](https://www.mintlify.com/docs/api-playground/openapi-setup), [monorepos](https://www.mintlify.com/docs/deploy/monorepo), [search MCP](https://www.mintlify.com/docs/ai/model-context-protocol), [external MCP](https://www.mintlify.com/docs/help-center/register-external-mcp-server-in-discovery).
