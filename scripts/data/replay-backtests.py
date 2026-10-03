#!/usr/bin/env python3
"""Recompute all perennial scenarios using public Verdant HTTP responses only.
No ZIP, credentials, archived scripts, or local data files are read.
"""

import argparse
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from backtest_common import content, digest, reconstruct, score


def get(origin, path):
    with urllib.request.urlopen(origin.rstrip("/") + path, timeout=60) as response:
        raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("API response exceeds documented limit")
        return json.loads(raw)


def fetch(origin, version, page_size=250):
    dataset = get(origin, "/api/v1/datasets/" + urllib.parse.quote(version, safe=""))[
        "dataset"
    ]
    rows = []
    cursor = ""
    seen = set()
    while True:
        try:
            page = get(
                origin,
                "/api/v1/datasets/"
                + version
                + "/observations?"
                + urllib.parse.urlencode({"limit": page_size, "after": cursor}),
            )
        except urllib.error.HTTPError as error:
            if error.code == 413 and page_size > 1:
                page_size = max(1, page_size // 2)
                continue
            raise
        if page["datasetVersion"] != version:
            raise ValueError("Version changed during pagination")
        rows.extend(page["observations"])
        nxt = page["nextCursor"]
        if nxt is None:
            break
        if not nxt or nxt in seen:
            raise ValueError("Repeated pagination cursor")
        seen.add(nxt)
        cursor = nxt
    if len(rows) != dataset["metadata"]["observation_count"] or len(
        {r["id"] for r in rows}
    ) != len(rows):
        raise ValueError("Incomplete/duplicate API cohort")
    if any(r["dataset_version_id"] != version for r in rows):
        raise ValueError("Mixed dataset versions")
    if digest(content(dataset, rows)) != dataset["content_sha256"]:
        raise ValueError("API content digest mismatch: " + version)
    return dataset, rows


def replay(origin, version):
    cases, rows = fetch(origin, version)
    if cases["metadata"]["replay_role"] != "scenario_references":
        raise ValueError("Not a scenario dataset")
    source, inputs = fetch(origin, cases["metadata"]["source_dataset_version"])
    tables = reconstruct(source, inputs)
    families = {}
    for row in rows:
        family = row["dimensions"]["family"]
        actual = score(family, row["dimensions"]["parameters"], tables)
        if not math.isfinite(actual) or not math.isclose(
            actual, row["value"], rel_tol=1e-10, abs_tol=1e-7
        ):
            raise ValueError((row["id"], actual, row["value"]))
        entry = families.setdefault(
            family,
            {"cases": 0, "max_abs_error": 0, "positive": 0, "negative": 0, "zero": 0},
        )
        entry["cases"] += 1
        entry["max_abs_error"] = max(entry["max_abs_error"], abs(actual - row["value"]))
        entry["positive" if actual > 0 else "negative" if actual < 0 else "zero"] += 1
    if {f: r["cases"] for f, r in families.items()} != cases["metadata"][
        "family_counts"
    ]:
        raise ValueError("Family counts mismatch")
    csiro = tables["csiro"]
    annual = []
    for year in sorted({int(r["harvest_year"]) for r in csiro}):
        c = next(
            r
            for r in csiro
            if int(r["harvest_year"]) == year and r["treatment_name"].split()[2] == "C"
        )
        for action in ["RDI", "PD"]:
            a = next(
                r
                for r in csiro
                if int(r["harvest_year"]) == year
                and r["treatment_name"].split()[2] == action
            )
            annual.append(
                {
                    "year": year,
                    "action": action,
                    "water_saved_m3_ha": (
                        c["recorded_irrigation_mm"] - a["recorded_irrigation_mm"]
                    )
                    * 10,
                    "yield_change_kg_ha": a["YLFW"] - c["YLFW"],
                }
            )
    return {
        "status": "PASS",
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "api_origin": origin,
        "source_dataset_version": source["id"],
        "scenario_dataset_version": cases["id"],
        "input_cells": len(inputs),
        "scenario_count": len(rows),
        "content_hashes_verified": True,
        "families": families,
        "csiro_annual_comparisons": annual,
        "evidence_limits": source["metadata"]["evidence_limits"],
        "scope": "Fresh API-sourced economic recomputation, not prospective scientific validation. No local handoff data was read.",
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("origin")
    p.add_argument("--scenario-version", required=True)
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    receipt = replay(args.origin, args.scenario_version)
    text = json.dumps(receipt, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
