# Production agriculture backtest data

The 3 October 2026 ZIP was reviewed and a bounded replay subset was published to the existing production partition. The full archive has 270,921 files and about 36.3 GiB of uncompressed contents, including experiments that failed and processing caches. Those caches are not application datasets.

All new data uses the existing immutable `verdant.dataset_versions` and `verdant.observations` tables and the existing published-only HTTP endpoints. No schema change or API redeployment was needed. Original CSIRO outcomes, irrigation schedules and the SILO map remain separate existing datasets. Sandbox data was not changed.

## Published versions

| Dataset | Immutable version | Contents |
|---|---|---|
| Perennial source inputs | `perennial-inputs-d3c609605ef64eb7` | 382 numeric/missing cells, categorical labels, source references, protocols and constants across seven almond/grape study families |
| Perennial scenarios | `perennial-scenarios-4c062dd28a270bf7` | All 6,184 parameter sets and archived regression targets, including negative cases |
| NWS rain decisions | `nws-day2-rain-824b6d331f2bbda0` | 363,972 wholly future day-two forecast/observation periods, grouped into 1,000 station-years |
| NWS frost decisions | `nws-day2-frost-13cd4dc470f5744b` | 77,008 wholly future day-two periods, grouped into 1,000 station-years |
| Ohio trial menus | `ohio-trials-6160e6c50ca0f5b2` | 230 treatment outcomes across 48 complete trials recovered from the partial public preview |
| Ohio frozen policies | `ohio-policies-b352e82b25799b75` | 432 decisions across all 24 penalty, advisory-fee and spending-cap variants |

These six active versions add 9,228 observation records. Two initial perennial versions were retired after correcting supplementary VIA unit labels (leaf area, shoot mass, leaf count and berry anthocyanins); their immutable history is retained. The active versions above contain the corrected labels. The NWS records contain aligned arrays to retain 440,980 individual periods without repeating station metadata in every row. They retain forecast-product and point identities, issue and period-end timestamps, raw/calibrated/history probabilities, observed precipitation/minimum temperature, coverage counts and event labels. NULL remains distinct from zero.

## Read through the production API

```sh
curl https://api.verdant-ai.com/api/v1/datasets/perennial-inputs-d3c609605ef64eb7
curl 'https://api.verdant-ai.com/api/v1/datasets/perennial-inputs-d3c609605ef64eb7/observations?limit=100'
curl 'https://api.verdant-ai.com/api/v1/datasets/nws-day2-rain-824b6d331f2bbda0/observations?limit=8'
```

Follow `nextCursor` using the `after` parameter until it is null. Dataset versions must remain pinned across pages. Forecast-series rows are larger; start at `limit=8` and reduce if an HTTP 413 response reports the one-megabyte response cap. The replay client does this automatically.

For perennial inputs, `metadata.tables` contains categorical labels by table and row index. Each observation's `dimensions.table`, `dimensions.row` and `variable` locate the numeric value. Reconstructing these tables requires both metadata and observations. No numeric measurement is replaced by a saved result.

For perennial scenarios, `dimensions.parameters` contains the scenario assumptions; `value` is an archived expected score. The replay independently calculates the score from source inputs and compares it to that target. Scenarios are explicitly classified as `simulation`, not measured outcomes.

For NWS, `value` is the station-year mean calibrated probability. Use the aligned arrays in `dimensions.series` for the decision replay. Probability arrays have unit 1, timestamps are Unix seconds UTC, precipitation is inches, and temperature is Fahrenheit. Protect when probability is greater than or equal to the cost/loss ratio. Calculate expense per period, average within each station-year, then average equally across station-years.

For Ohio, the source observation is yield in kg/ha; nitrogen dose, trial year and design attributes are dimensions. Frozen choices identify the selected and baseline doses. Prices and the hectares-to-acres conversion are explicit source metadata. Both equal-trial and equal-year summaries are calculated.

The bounded gridded `/data/query` endpoint still serves its existing raster contract. These studies use `/datasets/{version}/observations`.

## Reproduce without the ZIP or database credentials

Run from the repository root with Python 3.9 or later:

```sh
python3 scripts/data/replay-backtests.py https://api.verdant-ai.com \
  --scenario-version perennial-scenarios-4c062dd28a270bf7 \
  --output .work/verification/perennial-production-api.json

python3 scripts/data/replay-decision-studies.py https://api.verdant-ai.com \
  --output .work/verification/decision-studies-production-api.json
```

Both clients read scientific inputs exclusively from HTTP responses. They verify full normalized-content hashes, exact cohort counts and numerical agreement. They require no pandas, NumPy, ZIP, source CSVs or API secret. The forecast read can take several minutes because it fetches every underlying period in bounded pages.

Canonical content hashes cover `metadata` and observations sorted by ID, excluding `environment` and `dataset_version_id`. JSON object keys are sorted, nonfinite numbers are forbidden, and integral floats are normalized to integers so Python, PostgreSQL and JavaScript agree. Publication also checks every stored dataset metadata field and every observation field in both directions.

## Import again or into another partition

Preparation is offline, verifies selected ZIP members against `FILES.jsonl`, checks linked source hashes, and validates replay arithmetic before producing SQL. It never imports the archive's proposed application schema. Read the generated receipt and review the SQL before applying it.

```sh
python3 scripts/data/prepare-backtests.py /path/to/agriculture-backtesting-handoff-2026-10-03.zip \
  --environment production --output .work/import/perennial-production.sql

python3 scripts/data/prepare-ohio-replay.py /path/to/agriculture-backtesting-handoff-2026-10-03.zip \
  --environment production --output .work/import/ohio-production.sql
```

Forecast preparation alone needs the archive's pinned pandas 3.0.6 and NumPy 2.5.3 runtime. Install `scripts/data/requirements-forecast-replay.txt` into a separate Python 3.12 environment if needed, then run:

```sh
/path/to/forecast/python scripts/data/prepare-forecast-replay.py \
  /path/to/agriculture-backtesting-handoff-2026-10-03.zip \
  --environment production --output .work/import/nws-production.sql
```

The pickle loader permits an explicit list of numerical-data constructors and rejects arbitrary globals. The corresponding ZIP member is hash-verified before decoding. Preparation needs memory for the archived DataFrame, but does not extract the entire archive.

Local validation uses this project's existing isolated Postgres instance:

```sh
psql postgresql://postgres:postgres@127.0.0.1:58322/postgres \
  -X -v ON_ERROR_STOP=1 -f .work/import/perennial-production.sql
```

Apply each verified SQL file to the intended project explicitly:

```sh
python3 scripts/data/apply-verified-import.py .work/import/perennial-production.sql \
  --project-ref ulspzrnnwrfbgldphjpe --environment production
```

Repeat for the Ohio and NWS SQL files. The apply helper validates the receipt's environment and SQL hash, obtains a temporary connection through `supabase db dump --dry-run`, parses only connection variables without evaluating shell text, and uses the existing `service_role` grants. Credentials are not printed or written to disk. Direct Postgres avoids the Management API's request-size limit. The broad `postgres` role is not used.

Each import is one transaction: verify existing versions, insert missing staging versions and observations, compare all fields, then publish. Identical reruns perform no content writes. Any mismatch aborts the transaction. Existing published versions are never overwritten. Do not reset the production database.

## What has and has not been reproduced

- **Perennial:** all seven study families and 6,184 primary economic scores. Maximum independent Python/archived difference is 1.82e-12. The three CSIRO seasons and unfavorable Bellvert/Shackel results are retained. Published means do not become invented annual or replicate observations.
- **NWS:** the two curated day-two claims, all their declared cost/loss thresholds, all 15 replay years and all admitted station-seasons. Source probabilities are frozen past-only calibration outputs. The inputs support new decision thresholds and year-block uncertainty analyses, but the API replay does not refit calibration or reparse raw PFM/ASOS archives. Other leads are not imported. Archived bootstrap intervals are retained as references, not claimed as newly reproduced draws.
- **Ohio:** every frozen variant is rescored against observed discrete treatment outcomes, with advisory fees, added nitrogen costs, all evaluation years and alternative weighting. Complete preview training menus and frozen model coefficients are retained. The current replay does not re-optimize the shared-budget policy. The preview is not the full Dryad dataset.
- **Evidence:** perennial economics and NWS protection expenses are conditional models. NWS results are not measured crop-profit gains. Ohio is an exploratory historical partial-margin result with only three evaluation years and negative development performance. No general prospective profit benefit is established.
- **Outside this import:** NOAA array/vector benchmark fixtures, full papers, raw parsing caches, other lead-day experiments, crop engines and the remaining historical research archive. Source hashes and references are retained rather than redistributing papers.

The saved [production API verification receipt](backtest-verification-2026-10-03.json) records the complete comparisons and pinned versions. Security advisors reported no warnings after publication. Integrity tests cover altered values, duplicate cells, NULL/zero semantics, cross-runtime integral numbers and rejected pickle execution globals:

```sh
python3 -m unittest discover -s scripts/data -p 'test_backtest_integrity.py' -v
```
