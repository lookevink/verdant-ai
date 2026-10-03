#!/usr/bin/env python3
"""Verify the ZIP's curated perennial inputs and prepare an additive SQL import.
Standard library only. Never executes archived code or writes to a database.
"""

import argparse
import csv
import hashlib
import io
import json
import math
import zipfile
from pathlib import Path

from backtest_common import content, digest, encode, reconstruct, score

PREFIX = "agriculture-demo-2026-10-02/"
BASE = "workspace/research/perennial-backtest/"
TRANSFORM = "perennial-api-v1"
PARAMS = {
    "stewart": [
        "marginal_water_value_usd_acft",
        "monitoring_usd_ac",
        "price_usd_lb",
        "hypothetical_quality_discount",
        "hypothetical_yield_loss_lb_ac",
    ],
    "garcia": [
        "price_eur_kg",
        "water_price_eur_m3",
        "monitoring_eur_ha",
        "hypothetical_quality_discount",
        "water_cost_financing_factor",
    ],
    "bellvert": [
        "treatment",
        "price2023_eur_kg",
        "price2024_eur_kg",
        "discount",
        "hypothetical_year3_extra_yield_kg_ha",
        "hypothetical_extra_quality_value_eur_kg",
    ],
    "shackel": [
        "kernel_price_currency_per_lb",
        "annual_discount",
        "action_cost_currency_per_ac",
    ],
    "csiro": [
        "action",
        "crop_price_per_kg",
        "water_price_per_m3",
        "extra_cost_per_ha",
        "quality_price_multiplier",
    ],
    "summer": ["site", "year", "grape_price_per_kg", "quality_price_multiplier"],
    "winter": ["area_ha", "action", "grape_price_eur_kg", "extra_harvest_cost_eur_kg"],
}
TARGETS = {
    "stewart": "incremental_margin_usd_ac",
    "garcia": "incremental_margin_eur_ha",
    "bellvert": "incremental_partial_npv_eur_ha",
    "shackel": "incremental_four_year_npv_currency_per_ac",
    "csiro": "mean_incremental_margin_per_ha",
    "summer": "maximum_affordable_trimming_cost_without_water_credit_per_ha",
    "winter": "conditional_partial_margin_gain_eur_ha",
}
TABLES = {
    "bellvert": "bellvert-2025-table2.csv",
    "stewart_water": "stewart-2011-water-means.csv",
    "stewart_annual_water": "stewart-2011-annual-consumptive-water.csv",
    "stewart_yield": "stewart-2011-yield-quality-means.csv",
    "garcia": "garcia-2004-economic-means.csv",
    "garcia_annual_water": "garcia-2004-annual-water.csv",
    "shackel": "shackel-2012-table3.csv",
}
LABELS = {
    "year",
    "harvest_year",
    "treatment_number",
    "irrigation_level",
    "TRNO",
    "BBVD",
    "FFVD",
    "VVVD",
    "HHVD",
    "source_table",
    "table",
}


class Archive:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        if len(self.zip.namelist()) != len(set(self.zip.namelist())):
            raise ValueError("Duplicate ZIP members")
        with self.zip.open(PREFIX + "FILES.jsonl") as f:
            self.manifest = {r["path"]: r for line in f for r in [json.loads(line)]}
        self.verified = {}

    def read(self, name):
        b = self.zip.read(PREFIX + name)
        expected = self.manifest[name]
        h = hashlib.sha256(b).hexdigest()
        if h != expected["sha256"] or len(b) != expected["bytes"]:
            raise ValueError("Archive integrity failure: " + name)
        self.verified[name] = {"member_path": name, "sha256": h, "bytes": len(b)}
        return b

    def json(self, name):
        return json.loads(self.read(name))

    def csv(self, name):
        return list(csv.DictReader(io.StringIO(self.read(name).decode())))


def unit(key):
    exact = {
        "YLFW": "kg/ha",
        "YLDW": "kg/ha",
        "MXLA": "m2/vine",
        "SHDW": "g",
        "BUNO": "bunch/vine",
        "BUWT": "g",
        "BENO": "berry/bunch",
        "BEWT": "g",
        "BRIX": "degBrix",
        "LFNO": "count",
        "BAMG": "mg/g",
        "MAN": "EUR/ha",
        "MP": "EUR/ha",
        "MP+F": "EUR/ha",
        "brix": "degBrix",
        "pH": "pH",
        "reported_yield_p": "1",
        "yield_printed_plusminus": "lb/acre",
        "independent_blocks": "count",
        "independent_units_per_treatment": "count",
        "independent_replicate_plots": "count",
        "treatment_established": "year",
    }
    if key in exact:
        return exact[key]
    for suffix, label in [
        ("eur_hour", "EUR/hour"),
        ("eur_m3", "EUR/m3"),
        ("eur_kg", "EUR/kg"),
        ("eur_ha", "EUR/ha"),
        ("eur_farm", "EUR/farm"),
        ("m3_ha", "m3/ha"),
        ("kg_ha", "kg/ha"),
        ("lb_ac", "lb/acre"),
        ("kg_vine", "kg/vine"),
        ("vines_ha", "vines/ha"),
        ("hours_ha", "hour/ha"),
        ("pct", "%"),
        ("Brix", "degBrix"),
        ("gL", "g/L"),
        ("mm", "mm"),
        ("_in", "inch"),
        ("_g", "g"),
        ("_ha", "ha"),
    ]:
        if key.endswith(suffix):
            return label
    raise ValueError("Missing explicit unit for " + key)


def normalize(tables, env):
    definitions, cells = {}, []
    for table, rows in tables.items():
        labels = []
        for ordinal, row in enumerate(rows):
            label = {}
            for key, raw in row.items():
                number = None
                numeric = (
                    raw is None
                    or isinstance(raw, (int, float))
                    and not isinstance(raw, bool)
                )
                if isinstance(raw, str):
                    try:
                        number = float(raw)
                        numeric = math.isfinite(number)
                    except ValueError:
                        pass
                elif numeric:
                    number = raw
                if key in LABELS or not numeric:
                    label[key] = raw
                    continue
                if number is not None and not math.isfinite(number):
                    raise ValueError("Nonfinite input")
                cells.append(
                    dict(
                        environment=env,
                        dataset_version_id="",
                        id=f"{table}-{ordinal:04d}-{key}",
                        variable=key,
                        value=number,
                        unit=unit(key),
                        observed_on=None,
                        period_label=str(
                            row.get(
                                "period",
                                row.get(
                                    "year",
                                    row.get(
                                        "harvest_year",
                                        "study aggregate; see table metadata",
                                    ),
                                ),
                            )
                        ),
                        entity_id=f"{table}-{ordinal:04d}",
                        dimensions={"table": table, "row": ordinal},
                        quality_flags=["source_missing"]
                        if raw is None
                        else ["published_source_value"],
                    )
                )
            labels.append(label)
        definitions[table] = {"row_count": len(rows), "labels": labels}
    return definitions, cells


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def sql_import(datasets, observations):
    sql = [
        "begin;",
        "set local statement_timeout='120s';",
        "select pg_advisory_xact_lock(hashtextextended('verdant-perennial-import',0));",
    ]
    # Temporary expected tables carry each value once. EXCEPT ALL checks both directions.
    for table, rows in [("dataset_versions", datasets), ("observations", observations)]:
        columns = ",".join(rows[0])
        sql.append(
            f"create temporary table expected_{table} (like verdant.{table} including defaults) on commit drop;"
        )
        for start in range(0, len(rows), 250):
            sql.append(
                f"insert into expected_{table}({columns}) select {columns} from jsonb_populate_recordset(null::verdant.{table},{literal(encode(rows[start : start + 250]))}::jsonb);"
            )
    sql.append(
        "create temporary table new_datasets on commit drop as select e.environment,e.id from expected_dataset_versions e where not exists(select 1 from verdant.dataset_versions d where (d.environment,d.id)=(e.environment,e.id));"
    )
    for table, rows in [("dataset_versions", datasets), ("observations", observations)]:
        columns = ",".join(rows[0])
        qualified = ",".join("e." + k for k in rows[0])
        key = "id" if table == "dataset_versions" else "dataset_version_id"
        sql.append(
            f"insert into verdant.{table}({columns}) select {qualified} from expected_{table} e join new_datasets n on (n.environment,n.id)=(e.environment,e.{key});"
        )
        sql.append(
            f"do $verify$ begin if exists ((select {qualified} from verdant.{table} e join expected_dataset_versions d on (d.environment,d.id)=(e.environment,e.{key}) except all select {columns} from expected_{table}) union all (select {columns} from expected_{table} except all select {qualified} from verdant.{table} e join expected_dataset_versions d on (d.environment,d.id)=(e.environment,e.{key}))) then raise exception 'Import value mismatch: {table}'; end if; end $verify$;"
        )
    sql.append(
        "update verdant.dataset_versions d set status='published',published_at=now() from new_datasets n where (d.environment,d.id)=(n.environment,n.id);"
    )
    sql.append(
        "do $verify$ begin if exists(select 1 from verdant.dataset_versions d join expected_dataset_versions e using(environment,id) where d.status<>'published') then raise exception 'Dataset is not published'; end if; end $verify$;"
    )
    sql.append("commit;")
    return "\n".join(sql) + "\n"


def prepare(path, env):
    a = Archive(path)
    provenance = a.json(BASE + "almond/inputs/provenance.json")
    tables = {k: a.csv(BASE + "almond/inputs/" + v) for k, v in TABLES.items()}
    for src in provenance["source_tables"]:
        if (
            a.verified[BASE + "almond/inputs/" + src["input"]]["sha256"]
            != src["sha256"]
        ):
            raise ValueError("Input provenance mismatch")
    grape = a.json(BASE + "grape/normalized-inputs.json")
    via = a.read(
        "workspace/research/perennial-demo/grape/vinelogic/WNRA0305.via"
    ).decode()
    # Confirm the supplemental measurements and their units against the primary
    # source, including missing sentinels and YYDDD date codes.
    for definition in [
        "MXLA  Maximum leaf area per vine (square metres)",
        "SHDW  Shoot dry weight (g)",
        "LFNO  Leaf number",
        "BAMG  Berry anthocyanins (mg/g)",
    ]:
        if definition not in via:
            raise ValueError("CSIRO source unit definition changed: " + definition)
    columns = next(
        line.split()[1:] for line in via.splitlines() if line.startswith("@")
    )
    source_rows = {
        int(line.split()[0]): dict(zip(columns, line.split()))
        for line in via.splitlines()
        if line.strip() and line.strip()[0].isdigit()
    }
    if len(source_rows) != 9:
        raise ValueError("Incomplete primary CSIRO outcomes")
    for row in grape["csiro"]:
        raw = source_rows[row["treatment_number"]]
        for key in columns:
            value = (
                raw[key]
                if key in {"BBVD", "FFVD", "VVVD", "HHVD"}
                else (None if raw[key] == "-99" else float(raw[key]))
            )
            if row[key] != value:
                raise ValueError("CSIRO source transcription mismatch: " + key)
    for family, source in grape["sources"].items():
        for name, expected in source["hashes"].items():
            if (
                hashlib.sha256(
                    a.read("workspace/research/perennial-demo/grape/" + name)
                ).hexdigest()
                != expected
            ):
                raise ValueError("Grape source mismatch")
    for paper in provenance["papers"]:
        if (
            hashlib.sha256(
                a.read("workspace/research/perennial-demo/almond/" + paper["file"])
            ).hexdigest()
            != paper["sha256"]
        ):
            raise ValueError("Paper hash mismatch")
    tables.update(
        csiro=grape["csiro"],
        summer=grape["summer"],
        winter=grape["winter"]["rows"],
        winter_cost=grape["winter"]["cost_scenarios"],
        winter_metadata=[
            {
                k: v
                for k, v in grape["winter"].items()
                if k not in ("rows", "cost_scenarios")
            }
        ],
        constants=[{"garcia_water_tariff_eur_m3": 0.126}],
    )
    definitions, cells = normalize(tables, env)
    protocols = {
        "almond": a.read(BASE + "almond/PROTOCOL.md").decode(),
        "grape": a.json(BASE + "grape/protocol.json"),
    }
    if (
        hashlib.sha256(protocols["almond"].encode()).hexdigest()
        != provenance["protocol_sha256"]
    ):
        raise ValueError("Almond protocol changed")
    if (
        hashlib.sha256(a.read(BASE + "grape/protocol.json")).hexdigest()
        != a.json(BASE + "grape/protocol-receipt.json")["sha256"]
    ):
        raise ValueError("Grape protocol changed")
    gp = a.json(BASE + "grape/results.json")
    cases = []
    for family, target in TARGETS.items():
        rows = (
            a.csv(BASE + "almond/outputs/" + family + "_scenarios.csv")
            if family in ("stewart", "garcia", "bellvert", "shackel")
            else gp[family]["scenarios"]
        )
        for i, row in enumerate(rows):
            cases.append(
                dict(
                    environment=env,
                    dataset_version_id="",
                    id=f"{family}-{i:05d}",
                    variable=target,
                    value=float(row[target]),
                    unit={
                        "stewart": "USD/acre",
                        "garcia": "EUR/ha",
                        "bellvert": "EUR/ha",
                        "shackel": "currency/acre",
                        "csiro": "currency/ha",
                        "summer": "currency/ha",
                        "winter": "EUR/ha",
                    }[family],
                    observed_on=None,
                    period_label="frozen sensitivity case over published study period",
                    entity_id=family,
                    dimensions={
                        "family": family,
                        "parameters": {k: row[k] for k in PARAMS[family]},
                    },
                    quality_flags=[
                        "modeled_economic_scenario",
                        "not_independent_observation",
                    ],
                )
            )
    if len(cases) != 6184:
        raise ValueError("Incomplete scenario cohort")
    # Code/protocol hashes tie assumptions to the handoff without executing foreign code.
    for name in [
        "almond/run.py",
        "grape/run.py",
        "database_scenarios.py",
        "database-scenarios-receipt.json",
    ]:
        a.read(BASE + name)
    manifest = list(a.verified.values())
    common = dict(
        environment=env,
        transform_version=TRANSFORM,
        source_manifest=manifest,
        temporal_resolution="native study years and published multiyear aggregates; no invented annual values",
        spatial_support={"support": "published study sites; no inferred farm boundary"},
        period_start="1997-01-01",
        period_end="2024-12-31",
        license="Source-specific factual table transcriptions; paper licenses remain with their sources. No paper redistribution.",
        attribution="Stewart et al.; Garcia et al.; Bellvert et al.; Shackel et al.; CSIRO; Abad et al.; Trebbiano mechanization authors. See source references.",
        access_level="demo",
    )
    source = dict(
        common,
        dataset_key="perennial-replay-inputs",
        title="Seven perennial study replays: complete normalized source tables",
        data_class="published_aggregate",
        variables={r["variable"]: r["unit"] for r in cells},
        metadata={
            "replay_role": "source_inputs",
            "tables": definitions,
            "protocols": protocols,
            "sources": {
                "almond": [
                    dict(file=p["file"], url=p["source_url"], sha256=p["sha256"])
                    for p in provenance["papers"]
                ],
                "grape": grape["sources"],
            },
            "evidence_limits": [
                "Retrospective treatment replay; not forecast alpha or prospective profit validation.",
                "Keep all comparators and years. Scenario counts are not independent trials.",
                "Winter costs are published models. Summer water/cost nulls remain unknown.",
                "Stewart water and yield use different periods; consumptive-water discrepancy remains unresolved.",
                "Bellvert and Shackel unfavorable pruning results are retained.",
            ],
            "table_roles": {
                "winter_cost": "published operation-cost model",
                "constants": "published tariff assumption",
            },
            "observation_count": len(cells),
        },
    )
    source["content_sha256"] = digest(content(source, cells))
    source["id"] = "perennial-inputs-" + source["content_sha256"][:16]
    for r in cells:
        r["dataset_version_id"] = source["id"]
    scenario = dict(
        common,
        dataset_key="perennial-replay-scenarios",
        title="Perennial replay: all 6,184 frozen economic sensitivity cases",
        data_class="simulation",
        variables={r["variable"]: r["unit"] for r in cases},
        metadata={
            "replay_role": "scenario_references",
            "source_dataset_version": source["id"],
            "observation_count": len(cases),
            "family_counts": {
                f: sum(r["entity_id"] == f for r in cases) for f in TARGETS
            },
            "interpretation": "Parameters are replay inputs; value is the archived regression target, not a measured outcome. Recompute using the source dataset.",
            "family_endpoints": TARGETS,
            "evidence_limits": source["metadata"]["evidence_limits"],
        },
    )
    scenario["content_sha256"] = digest(content(scenario, cases))
    scenario["id"] = "perennial-scenarios-" + scenario["content_sha256"][:16]
    for r in cases:
        r["dataset_version_id"] = scenario["id"]
    normalized = reconstruct(source, cells)
    errors = {}
    for r in cases:
        f = r["entity_id"]
        actual = score(f, r["dimensions"]["parameters"], normalized)
        if not math.isclose(actual, r["value"], rel_tol=1e-10, abs_tol=1e-7):
            raise ValueError((r["id"], actual, r["value"]))
        errors[f] = max(errors.get(f, 0), abs(actual - r["value"]))
    return (
        [source, scenario],
        cells + cases,
        {
            "verified_members": len(manifest),
            "input_cells": len(cells),
            "scenario_count": len(cases),
            "family_counts": scenario["metadata"]["family_counts"],
            "max_abs_errors": errors,
        },
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive", type=Path)
    p.add_argument("--environment", choices=["sandbox", "production"], required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    datasets, observations, receipt = prepare(args.archive, args.environment)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(sql_import(datasets, observations))
    receipt.update(
        environment=args.environment,
        dataset_ids=[d["id"] for d in datasets],
        sql_sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),
    )
    args.output.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    args.output.with_suffix(".expected.json").write_text(
        encode({"datasets": datasets, "observations": observations})
    )
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
