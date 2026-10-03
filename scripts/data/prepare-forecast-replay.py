#!/usr/bin/env python3
"""Import the complete day-two cohorts for the handoff's two NWS decision claims.
Requires the handoff's pandas 3.0.6 / numpy 2.5.3 runtime only for preparation.
Stores columnar station-season series to avoid repeating metadata for 440,980 periods.
"""

import argparse
import hashlib
import importlib.util
import io
import json
import statistics
from pathlib import Path

from backtest_common import content, digest
from forecast_pickle import Safe
from forecast_replay import summarize

spec = importlib.util.spec_from_file_location(
    "prepare", Path(__file__).with_name("prepare-backtests.py")
)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
BASE = "workspace/experiment/audit_reruns/nws/"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive", type=Path)
    p.add_argument("--environment", choices=["sandbox", "production"], required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    a = prepare.Archive(args.archive)
    results = a.json(BASE + "output/future-only/results.json")
    protocol = a.json("workspace/experiment/information_value/protocol.json")
    a.read(BASE + "score.py")
    a.read(BASE + "PROTOCOL.md")
    a.read(BASE + "build.py")
    allrows = []
    datasets = []
    metrics = {}
    for family in ["rain", "frost"]:
        path = BASE + "output/future-only/" + family + "-replay.pkl"
        df = Safe(io.BytesIO(a.read(path))).load()
        df = df[df.lead_day == 2].copy()
        if not (df.lead_h >= 12).all() or df.began_before_issue.any():
            raise ValueError("Period began before issue")
        if df.duplicated(["product_id", "point_id", "period_end_utc"]).any():
            raise ValueError("Duplicate forecast identity")
        if (
            not (df.period_end_utc - df.issued_utc)
            .dt.total_seconds()
            .ge(12 * 3600)
            .all()
        ):
            raise ValueError("Forecast time leakage")
        rows = []
        for (station, year), g in df.groupby(
            ["station", "year"], observed=True, sort=True
        ):
            g = g.sort_values(["issued_utc", "period_end_utc", "point_id"])
            s = {}
            for name in [
                "product_id",
                "point_id",
                "p_cal",
                "p_raw",
                "trail",
                "event",
                "value",
                "precip_in",
                "tmin_f",
                "precip_hours_ok",
                "temp_hours_ok",
            ]:
                # NaN remains null; none of p_cal/trail/event may be missing.
                s[name] = [None if v != v else v for v in g[name].tolist()]
            for name in ["issued_utc", "period_end_utc"]:
                s[name] = [int(x.timestamp()) for x in g[name]]
            for key in ["p_cal", "p_raw", "trail"]:
                if any(v is None or not 0 <= v <= 1 for v in s[key]):
                    raise ValueError("Missing/invalid probability")
            if any(v not in (0, 1) for v in s["event"]):
                raise ValueError("Missing event")
            rows.append(
                dict(
                    environment=args.environment,
                    dataset_version_id="",
                    id=f"{station}-{year}",
                    variable="mean_calibrated_event_probability",
                    value=statistics.mean(s["p_cal"]),
                    unit="1",
                    observed_on=None,
                    period_label=str(year),
                    entity_id=str(station),
                    dimensions={
                        "year": int(year),
                        "station": str(station),
                        "lead_day": 2,
                        "period_count": len(g),
                        "series": s,
                    },
                    quality_flags=[
                        "derived_past_only_calibration",
                        "frozen_model_replay",
                        "wholly_future_periods",
                    ],
                )
            )
        refs = (
            results["replay_pop"]["2"]
            if family == "rain"
            else results["frost"]["replay"]["2"]
        )
        meta = {
            "replay_role": "forecast_decision_inputs",
            "family": family,
            "lead_day": 2,
            "observation_count": len(rows),
            "period_count": len(df),
            "series_layout": "Each observation is a station-year; value is mean p_cal. dimensions.series holds aligned per-period arrays used for decisions.",
            "series_units": {
                "issued_utc": "Unix seconds UTC",
                "period_end_utc": "Unix seconds UTC",
                "p_cal": "1",
                "p_raw": "1",
                "trail": "1",
                "event": "0/1",
                "value": "percent PoP" if family == "rain" else "degF",
                "precip_in": "inch",
                "tmin_f": "degF",
                "precip_hours_ok": "hour",
                "temp_hours_ok": "hour",
            },
            "event_definition": "12-hour precipitation >= 0.01 inch"
            if family == "rain"
            else "12-hour minimum temperature <= 32 degF in prescribed spring/autumn windows",
            "policy": "Protect when probability >= cost/loss ratio. Expense = ratio when protected; otherwise observed event. Perfect protection is modeled.",
            "aggregation": "Mean within station-year, then equal weight across station-years. Year-block uncertainty must resample whole years.",
            "reference_summaries": refs,
            "source_protocol": protocol,
            "source_row_key": ["product_id", "point_id", "period_end_utc"],
            "scope": "All years and stations for the day-two rain/frost claim and all declared cost/loss thresholds. Frozen calibration outputs, not fresh model refitting.",
            "not_imported": [
                "Other lead days",
                "Raw PFM/ASOS parsing caches",
                "Training pairs for recalibration",
            ],
            "evidence_limits": [
                "Modeled protection expense, not observed crop profit or measured avoided farm losses.",
                "Exposed historical data; not new prospective validation.",
            ],
        }
        d = dict(
            environment=args.environment,
            dataset_key="nws-future-day2-" + family,
            title="NWS wholly future day-two " + family + " decision replay",
            transform_version="nws-frozen-decisions-v1",
            data_class="forecast",
            source_manifest=list(a.verified.values()),
            variables={"mean_calibrated_event_probability": "1"},
            temporal_resolution="12-hour forecast periods grouped by station-year",
            spatial_support={
                "support": "historical forecast point matched to ASOS station within 5 km; point identity preserved per period"
            },
            period_start=str(df.period_end_utc.min().date()),
            period_end=str(df.period_end_utc.max().date()),
            license="NOAA/NWS US government forecasts and ASOS observations; derived research calibration outputs.",
            attribution="NOAA/NWS; ASOS; Iowa Environmental Mesonet historical archive; corrected handoff forecast-point matching and calibration.",
            access_level="demo",
            metadata=meta,
        )
        d["content_sha256"] = digest(content(d, rows))
        d["id"] = "nws-day2-" + family + "-" + d["content_sha256"][:16]
        for r in rows:
            r["dataset_version_id"] = d["id"]
        actual = summarize(d, rows)
        metrics[family] = actual
        datasets.append(d)
        allrows.extend(rows)
        print(
            json.dumps(
                {
                    "family": family,
                    "periods": len(df),
                    "seasons": len(rows),
                    "validated": True,
                }
            ),
            flush=True,
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(prepare.sql_import(datasets, allrows))
    receipt = {
        "environment": args.environment,
        "dataset_ids": [d["id"] for d in datasets],
        "sql_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "verified_members": len(a.verified),
        "replay_metrics": metrics,
    }
    args.output.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            {
                "datasets": receipt["dataset_ids"],
                "sql_bytes": args.output.stat().st_size,
            }
        )
    )


if __name__ == "__main__":
    main()
