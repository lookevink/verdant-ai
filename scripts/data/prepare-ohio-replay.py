#!/usr/bin/env python3
"""Ingest complete Ohio preview trial menus and all 24 frozen policy variants."""

import argparse
import hashlib
import importlib.util
import json
from collections import defaultdict
from pathlib import Path

from backtest_common import content, digest
from ohio_replay import summarize

spec = importlib.util.spec_from_file_location(
    "prepare", Path(__file__).with_name("prepare-backtests.py")
)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
BASE = "workspace/experiment/data/raw/external/ohio-nitrogen/"
AUDIT = "workspace/experiment/audit_reruns/state_external/"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive", type=Path)
    p.add_argument("--environment", choices=["sandbox", "production"], required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    a = prepare.Archive(args.archive)
    crop = a.csv(BASE + "Crop_Data.preview.csv")
    design = a.csv(BASE + "Experimental_Design.preview.csv")
    frozen = a.json(AUDIT + "ohio-frozen-choices.json")
    refs = a.json(AUDIT + "ohio-results.json")
    a.read(AUDIT + "external.py")
    a.read("workspace/experiment/external/data.py")
    a.read("workspace/experiment/external/evaluate.py")
    source_info = a.json(BASE + "dryad-dataset.json")
    if source_info.get("license") != "https://spdx.org/licenses/CC0-1.0.html":
        raise ValueError("Unexpected Ohio source license")
    a.read(BASE + "preview-acquisition-manifest.json")
    designs = {int(r["Trial"]): r for r in design}
    if len(designs) != len(design):
        raise ValueError("Duplicate design identity")
    groups = defaultdict(list)
    for r in crop:
        groups[int(r["Trial"])].append(r)
    rows = []
    excluded = []
    for trial, group in sorted(groups.items()):
        d = designs[trial]
        try:
            rates = [float(r["Total_N"]) for r in group]
            yields = [float(r["Yield"]) * 1000 for r in group]
        except ValueError:
            excluded.append(trial)
            continue
        if not (
            len(group) == int(d["Number_N_Rates"])
            and len(group) >= 4
            and d["Trt_vs_Plot"] == "Treatment"
            and len(set(rates)) == len(rates)
            and min(rates) >= 0
            and min(yields) > 0
        ):
            excluded.append(trial)
            continue
        for i, (r, n, y) in enumerate(zip(group, rates, yields)):
            rows.append(
                dict(
                    environment=args.environment,
                    dataset_version_id="",
                    id=f"{trial:04d}-{i:03d}",
                    variable="yield_kg_ha",
                    value=y,
                    unit="kg/ha",
                    observed_on=None,
                    period_label=d["Year"],
                    entity_id=str(trial),
                    dimensions={
                        "trial": trial,
                        "year": int(d["Year"]),
                        "n_kg_ha": n,
                        "design": {k: None if v == "." else v for k, v in d.items()},
                        "n_components_kg_ha": {
                            k: None if r[k] == "." else float(r[k])
                            for k in ["PrePlant_N", "AtPlant_N", "Sidedress_N"]
                        },
                        "source_yield_unit": "Mg/ha",
                    },
                    quality_flags=[
                        "complete_trial_from_partial_public_preview",
                        "observed_treatment_mean",
                    ],
                )
            )
    if len({r["entity_id"] for r in rows}) != 48:
        raise ValueError("Unexpected Ohio trial count")
    common = dict(
        environment=args.environment,
        transform_version="ohio-frozen-policy-v1",
        source_manifest=list(a.verified.values()),
        temporal_resolution="trial year",
        spatial_support={
            "support": "Ohio trial/county labels; no field geometry inferred"
        },
        period_start="1976-01-01",
        period_end="1990-12-31",
        license="CC0 (Dryad data); public first-chunk preview only",
        attribution="Ohio corn nitrogen trials; Dryad doi:10.5061/dryad.3bk3j9kxg.",
        access_level="demo",
    )
    d = dict(
        common,
        dataset_key="ohio-nitrogen-trials",
        title="Ohio nitrogen: complete trial menus recovered from the public preview",
        data_class="observation",
        variables={"yield_kg_ha": "kg/ha"},
        metadata={
            "replay_role": "ohio_trial_inputs",
            "observation_count": len(rows),
            "trial_count": 48,
            "excluded_trials": excluded,
            "source_url": "https://doi.org/10.5061/dryad.3bk3j9kxg",
            "prices": {
                "grain_usd_kg": 0.158,
                "nitrogen_usd_kg": 0.88,
                "acres_per_hectare": 2.471053814671653,
            },
            "development_years": [1976, 1977, 1978, 1979, 1980],
            "evaluation_years": [1986, 1989, 1990],
            "limits": "Public preview, not the complete Dryad dataset. Only 18 evaluation trials across three unequally represented years; no operational forecast input.",
        },
    )
    d["content_sha256"] = digest(content(d, rows))
    d["id"] = "ohio-trials-" + d["content_sha256"][:16]
    for r in rows:
        r["dataset_version_id"] = d["id"]
    cases = []
    for i, (variant, reference) in enumerate(zip(frozen["variants"], refs)):
        for key in ["alpha", "primary", "fee", "policy"]:
            if variant[key] != reference[key]:
                raise ValueError("Variant identity mismatch")
        wanted = {r["trial"]: r for r in reference["rows"]}
        for choice in variant["choices"]:
            r = wanted[choice["trial"]]
            if any(choice[k] != r[k] for k in choice):
                raise ValueError("Frozen choice mismatch")
            cases.append(
                dict(
                    environment=args.environment,
                    dataset_version_id="",
                    id=f"{i:02d}-{int(choice['trial']):04d}",
                    variable="partial_margin_change",
                    value=r["net_acre"],
                    unit="USD/acre",
                    observed_on=None,
                    period_label=str(choice["year"]),
                    entity_id=str(choice["trial"]),
                    dimensions={"variant": i, "choice": choice},
                    quality_flags=[
                        "frozen_model_choice",
                        "illustrative_prices",
                        "not_net_farm_profit",
                    ],
                )
            )
    md = {
        "replay_role": "ohio_frozen_choices",
        "source_dataset_version": d["id"],
        "observation_count": len(cases),
        "primary_alpha": frozen["primary_alpha"],
        "development_scores": frozen["inner_scores"],
        "variants": [
            {k: v for k, v in x.items() if k != "choices"} for x in frozen["variants"]
        ],
        "reference_summaries": [
            {k: v for k, v in x.items() if k != "rows"} for x in refs
        ],
        "scope": "Replay all 24 frozen policy variants against observed discrete treatment outcomes. Training menus and frozen coefficients retained; no claim of fresh policy optimization.",
        "limits": [
            "All candidates lost during development; selected candidate was least unfavorable.",
            "Spending caps remove the positive primary gain.",
            "Historical partial margins at fixed prices; not prospective farmer benefit.",
        ],
    }
    c = dict(
        common,
        dataset_key="ohio-nitrogen-policy-replay",
        title="Ohio nitrogen: all frozen penalty, advisory fee and spending-cap variants",
        data_class="simulation",
        variables={"partial_margin_change": "USD/acre"},
        metadata=md,
    )
    c["content_sha256"] = digest(content(c, cases))
    c["id"] = "ohio-policies-" + c["content_sha256"][:16]
    for r in cases:
        r["dataset_version_id"] = c["id"]
    actual = summarize(d, rows, c, cases)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(prepare.sql_import([d, c], rows + cases))
    receipt = {
        "environment": args.environment,
        "dataset_ids": [d["id"], c["id"]],
        "sql_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "trial_rows": len(rows),
        "choice_rows": len(cases),
        "variants": len(actual),
        "verified_members": len(a.verified),
    }
    args.output.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
