#!/usr/bin/env python3
"""Verify NWS day-two and Ohio frozen-policy backtests through the public API.
Only Python's standard library is needed. No local scientific data is read.
"""

import argparse
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from forecast_replay import summarize as forecast
from ohio_replay import summarize as ohio

spec = importlib.util.spec_from_file_location(
    "http_replay", Path(__file__).with_name("replay-backtests.py")
)
http = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("origin")
    p.add_argument("--rain-version", default="nws-day2-rain-824b6d331f2bbda0")
    p.add_argument("--frost-version", default="nws-day2-frost-13cd4dc470f5744b")
    p.add_argument("--ohio-version", default="ohio-policies-b352e82b25799b75")
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    result = {
        "status": "PASS",
        "api_origin": args.origin,
        "content_hashes_verified": True,
        "forecast": {},
    }
    for family, version in [("rain", args.rain_version), ("frost", args.frost_version)]:
        print(
            "Fetching " + family + " station-season series from the API...", flush=True
        )
        d, rows = http.fetch(args.origin, version, page_size=8)
        result["forecast"][family] = {
            "dataset_version": version,
            "period_count": d["metadata"]["period_count"],
            "comparisons": forecast(d, rows),
        }
        print(
            f"{family}: {d['metadata']['period_count']} periods and all day-two cost/loss comparisons PASS",
            flush=True,
        )
    print("Fetching Ohio trial menus and frozen choices from the API...", flush=True)
    c, cases = http.fetch(args.origin, args.ohio_version)
    d, rows = http.fetch(args.origin, c["metadata"]["source_dataset_version"])
    result["ohio"] = {
        "source_dataset_version": d["id"],
        "scenario_dataset_version": c["id"],
        "treatment_outcomes": len(rows),
        "comparisons": ohio(d, rows, c, cases),
    }
    result.update(
        checked_at_utc=datetime.now(timezone.utc).isoformat(),
        scope="Decision replay from frozen forecast/model inputs and observed outcomes; no model refit. NWS bootstrap intervals retained as references, not freshly reproduced. Other forecast leads and raw caches excluded.",
    )
    text = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
