"""Cost/loss arithmetic over forecast inputs, independent of the archive scorer."""

import math
import statistics


def summarize(dataset, rows):
    meta = dataset["metadata"]
    result = []
    if (
        len(rows) != 1000
        or sum(r["dimensions"]["period_count"] for r in rows) != meta["period_count"]
    ):
        raise ValueError("Incomplete forecast cohort")
    for reference in meta["reference_summaries"]:
        alpha = reference["alpha"]
        season = {p: [] for p in ["H", "F_raw", "F_cal", "P"]}
        for r in rows:
            s = r["dimensions"]["series"]
            n = r["dimensions"]["period_count"]
            if any(len(v) != n for v in s.values()):
                raise ValueError("Misaligned series")
            if any(
                end - issue < 12 * 3600
                for issue, end in zip(s["issued_utc"], s["period_end_utc"])
            ):
                raise ValueError("Time leakage")
            expected_events = (
                [int(v >= 0.01) for v in s["precip_in"]]
                if meta["family"] == "rain"
                else [int(v <= 32) for v in s["tmin_f"]]
            )
            if expected_events != s["event"]:
                raise ValueError("Event does not match observed weather")
            for policy, column in [
                ("H", "trail"),
                ("F_raw", "p_raw"),
                ("F_cal", "p_cal"),
            ]:
                season[policy].append(
                    statistics.mean(
                        alpha if p >= alpha else float(e)
                        for p, e in zip(s[column], s["event"])
                    )
                )
            season["P"].append(alpha * statistics.mean(s["event"]))
        summary = {
            "alpha": alpha,
            "n_seasons": len(rows),
            "n_years": len({r["dimensions"]["year"] for r in rows}),
        }
        h = statistics.mean(season["H"])
        for policy, values in season.items():
            value = statistics.mean(values)
            summary.update(
                {
                    f"E_{policy}": value,
                    f"dE_{policy}": value - h,
                    f"pct_saving_{policy}": (h - value) / h,
                }
            )
        for key, value in summary.items():
            if not math.isclose(value, reference[key], rel_tol=1e-9, abs_tol=1e-9):
                raise ValueError(
                    (
                        "Forecast replay mismatch",
                        meta["family"],
                        key,
                        value,
                        reference[key],
                    )
                )
        result.append(summary)
    return result
