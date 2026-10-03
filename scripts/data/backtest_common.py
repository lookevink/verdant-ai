"""Canonical backtest payloads shared by the offline importer and HTTP replay."""

import hashlib
import json
import math


def encode(value):
    # JSON/Postgres/JavaScript do not retain the distinction between 1 and 1.0.
    def canonical(v):
        if isinstance(v, float) and math.isfinite(v) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: canonical(x) for k, x in v.items()}
        if isinstance(v, list):
            return [canonical(x) for x in v]
        return v

    return json.dumps(
        canonical(value),
        sort_keys=True,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def content(dataset, observations):
    """Exclude database identity/timestamps; include scientific metadata and every cell."""
    return {
        "metadata": dataset["metadata"],
        "observations": [
            {
                k: v
                for k, v in row.items()
                if k not in ("environment", "dataset_version_id")
            }
            for row in sorted(observations, key=lambda r: r["id"])
        ],
    }


def reconstruct(dataset, observations):
    if digest(content(dataset, observations)) != dataset["content_sha256"]:
        raise ValueError("API content digest mismatch: " + dataset["id"])
    tables = {
        k: [dict(r) for r in v["labels"]]
        for k, v in dataset["metadata"]["tables"].items()
    }
    seen = set()
    for cell in observations:
        d = cell["dimensions"]
        key = (d["table"], d["row"], cell["variable"])
        if key in seen:
            raise ValueError("Duplicate input cell")
        seen.add(key)
        tables[d["table"]][d["row"]][cell["variable"]] = cell["value"]
    return tables


def score(family, p, t):
    """Independent scalar translation of the archived SQL replay, from API inputs."""
    p = {
        k: float(v)
        if isinstance(v, (int, float)) or isinstance(v, str) and _number(v)
        else v
        for k, v in p.items()
    }

    def arm(table, treatment):
        return next(
            r for r in t[table] if r.get("treatment", r.get("action")) == treatment
        )

    if family == "stewart":
        c, a = arm("stewart_water", "Control"), arm("stewart_water", "RDI")
        y = arm("stewart_yield", "Control")["yield_lb_ac"]
        saved = (c["applied_water_in"] - a["applied_water_in"]) / 12
        return (
            saved * p["marginal_water_value_usd_acft"]
            - p["monitoring_usd_ac"]
            - p["price_usd_lb"] * p["hypothetical_yield_loss_lb_ac"]
            - p["price_usd_lb"]
            * p["hypothetical_quality_discount"]
            * (y - p["hypothetical_yield_loss_lb_ac"])
        )
    if family == "garcia":
        c, a = arm("garcia", "Control"), arm("garcia", "RDI")
        return (
            a["profit_eur_farm"] / a["economic_farm_area_ha"]
            - c["profit_eur_farm"] / c["economic_farm_area_ha"]
            + (a["yield_kg_ha"] - c["yield_kg_ha"])
            * (p["price_eur_kg"] - c["price_eur_kg"])
            + (c["water_m3_ha"] - a["water_m3_ha"])
            * (
                p["water_price_eur_m3"]
                - t["constants"][0]["garcia_water_tariff_eur_m3"]
            )
            * p["water_cost_financing_factor"]
            - p["monitoring_eur_ha"]
            - a["yield_kg_ha"] * p["price_eur_kg"] * p["hypothetical_quality_discount"]
        )
    if family == "bellvert":
        if p["treatment"] == "Control":
            return 0.0
        selected = [r for r in t["bellvert"] if r["treatment"] == p["treatment"]]
        total = 0.0
        for a in selected:
            c = next(
                r
                for r in t["bellvert"]
                if r["treatment"] == "Control" and r["year"] == a["year"]
            )
            total += (
                (a["kernel_yield_kg_ha"] - c["kernel_yield_kg_ha"])
                * p["price" + str(a["year"]) + "_eur_kg"]
                + a["kernel_yield_kg_ha"] * p["hypothetical_extra_quality_value_eur_kg"]
            ) / (1 + p["discount"]) ** (int(a["year"]) - 2023)
        return (
            total
            - sum(a["action_cost_eur_ha"] for a in selected)
            + p["hypothetical_year3_extra_yield_kg_ha"]
            * p["price2024_eur_kg"]
            / (1 + p["discount"]) ** 2
        )
    if family == "shackel":
        total = 0.0
        for a in t["shackel"]:
            if a["treatment"] != "Pruned or pruned+kaolin":
                continue
            c = next(
                r
                for r in t["shackel"]
                if r["treatment"] == "Non-modified" and r["year"] == a["year"]
            )
            total += (
                (a["kernel_yield_lb_ac"] - c["kernel_yield_lb_ac"])
                * p["kernel_price_currency_per_lb"]
                / (1 + p["annual_discount"]) ** (int(a["year"]) - 2009)
            )
        return total - p["action_cost_currency_per_ac"]
    if family == "csiro":
        values = []
        for a in t["csiro"]:
            if a["treatment_name"].split()[2] != p["action"]:
                continue
            c = next(
                r
                for r in t["csiro"]
                if r["harvest_year"] == a["harvest_year"]
                and r["treatment_name"].split()[2] == "C"
            )
            values.append(
                p["crop_price_per_kg"]
                * (p["quality_price_multiplier"] * a["YLFW"] - c["YLFW"])
                + p["water_price_per_m3"]
                * (c["recorded_irrigation_mm"] - a["recorded_irrigation_mm"])
                * 10
                - p["extra_cost_per_ha"]
            )
        if len(values) != 3:
            raise ValueError("Incomplete CSIRO cohort")
        return sum(values) / len(values)
    if family == "summer":
        a = next(
            r
            for r in t["summer"]
            if r["site"] == p["site"] and int(r["year"]) == p["year"]
        )
        return (
            p["grape_price_per_kg"]
            * a["density_vines_ha"]
            * (
                p["quality_price_multiplier"] * a["trim_yield_kg_vine"]
                - a["control_yield_kg_vine"]
            )
        )
    if family == "winter":
        c, a = arm("winter", "MAN"), arm("winter", p["action"])
        cost = next(r for r in t["winter_cost"] if r["area_ha"] == p["area_ha"])
        return (
            (p["grape_price_eur_kg"] - p["extra_harvest_cost_eur_kg"])
            * (a["yield_kg_vine"] - c["yield_kg_vine"])
            * t["winter_metadata"][0]["density_vines_ha"]
            + cost["MAN"]
            - cost[p["action"]]
        )
    raise ValueError("Unknown family: " + family)


def _number(v):
    try:
        return math.isfinite(float(v))
    except ValueError:
        return False
