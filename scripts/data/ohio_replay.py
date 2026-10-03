"""Recompute frozen Ohio decisions against API-observed outcomes and explicit prices."""

import math
import statistics
from collections import defaultdict


def summarize(source, observations, scenarios, cases):
    price = source["metadata"]["prices"]
    p = price["grain_usd_kg"]
    c = price["nitrogen_usd_kg"]
    acres = price["acres_per_hectare"]
    outcomes = {
        (r["dimensions"]["trial"], r["dimensions"]["n_kg_ha"]): r["value"]
        for r in observations
    }
    years = {r["dimensions"]["trial"]: r["dimensions"]["year"] for r in observations}
    grouped = defaultdict(list)
    for row in cases:
        v = row["dimensions"]["variant"]
        r = row["dimensions"]["choice"]
        variant = scenarios["metadata"]["variants"][v]
        if years[r["trial"]] != r["year"]:
            raise ValueError("Trial year mismatch")
        dy = (
            outcomes[(r["trial"], r["action"])]
            - outcomes[(r["trial"], r["baseline_action"])]
        )
        fee = 0 if r["action"] == r["baseline_action"] else variant["fee"]
        cost = (r["action"] - r["baseline_action"]) * c + fee * acres
        value = (dy * p - cost) / acres
        if not math.isclose(cost, r["cost_delta_ha"], abs_tol=1e-9) or not math.isclose(
            value, row["value"], abs_tol=1e-9
        ):
            raise ValueError("Ohio outcome mismatch")
        grouped[v].append((r["year"], value, cost))
    result = []
    for v, rows in sorted(grouped.items()):
        by = defaultdict(list)
        for year, value, cost in rows:
            by[year].append(value)
        ref = scenarios["metadata"]["reference_summaries"][v]
        variant = scenarios["metadata"]["variants"][v]
        equal_year = statistics.mean(statistics.mean(x) for x in by.values())
        if (
            not math.isclose(equal_year, ref["mean_net_acre_equal_year"], abs_tol=1e-9)
            or len(rows) != ref["trials"]
            or len(by) != ref["independent_years"]
        ):
            raise ValueError("Ohio aggregation mismatch")
        for refyear in ref["by_year"]:
            if not math.isclose(
                statistics.mean(by[refyear["year"]]), refyear["net_acre"], abs_tol=1e-9
            ):
                raise ValueError("Ohio annual mismatch")
        result.append(
            {
                "variant": v,
                "alpha": variant["alpha"],
                "fee": variant["fee"],
                "policy": variant["policy"],
                "primary": variant["primary"],
                "trials": len(rows),
                "equal_trial_usd_acre": statistics.mean(r[1] for r in rows),
                "equal_year_usd_acre": equal_year,
            }
        )
    if len(result) != 24:
        raise ValueError("Incomplete variant set")
    return result
