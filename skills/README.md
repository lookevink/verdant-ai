# Verdant backtesting skills

[![skills.sh](https://skills.sh/b/lookevink/verdant-ai)](https://skills.sh/lookevink/verdant-ai)

Reusable agent workflows backed by `https://api.verdant-ai.com` and its `/mcp`
endpoint. Scientific inputs come from the service; no local handoff data or
private database access is required.

```sh
npx skills add lookevink/verdant-ai --skill verdant-data-discovery verdant-forecast-backtest verdant-perennial-economics verdant-nitrogen-replay
```

| Skill | Workflow |
| --- | --- |
| [verdant-data-discovery](verdant-data-discovery/SKILL.md) | Find suitable evidence, validate coverage, fetch complete immutable datasets, specify missing data |
| [verdant-forecast-backtest](verdant-forecast-backtest/SKILL.md) | Replay rain/frost protection decisions and cost/loss sensitivity |
| [verdant-perennial-economics](verdant-perennial-economics/SKILL.md) | Compare irrigation/pruning programs, recovery horizons and conditional economics |
| [verdant-nitrogen-replay](verdant-nitrogen-replay/SKILL.md) | Rescore frozen Ohio policies against observed menus with fees and year weighting |

Each folder is independently installable. Installing a skill does not register
an MCP connection. See the [installation and usage guide](../docs/agents/skills.mdx)
and [MCP connection guide](../docs/agents/mcp.mdx).

These workflows adapt the perennial, NWS and Ohio retrospective protocols from
the supabase-hackathon research project, plus the Verdant API-only discovery
evaluation. They preserve cohort completeness, timing, units, negative outcomes,
and the distinction between replay and fresh fitting. No expected numeric
backtest scores are bundled. Missing evidence is reported; the current service
does not acquire it automatically.
