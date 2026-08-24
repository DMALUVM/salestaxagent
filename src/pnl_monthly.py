"""Monthly Amazon contribution from sales_by_sku × sku_costs.

Daily `pnl_daily` only covers the last few weeks. `sales_by_sku` already
holds Amazon month × SKU × state from 2024-08 through the current month
(~$2.86M). This module turns that into the same contribution formula the
daily writer uses, without another SP-API pull:

    contribution = gross_sales - referral - fba - ad_spend - cogs

Shopify is ignored — SKU economics here is Amazon-only.

Ads: summed from `ads_campaigns_daily` when that month has any campaign
row. Months before ads coverage store $0 spend with ads_basis=unknown so
the figure is labelled *before ads*, not "after $0 spend".

COGS is `sku_costs` only (business rule 6). Missing SKUs use the average
unit cost of priced SKUs, same as the daily writer.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date

from src.db import fetch_all, upsert_rows
from src.pnl import DEFAULT_FBA_FEE_PER_UNIT, DEFAULT_REFERRAL_PCT
from src.rules import AMAZON_PULSE_SOURCE, amazon_as_of
from src.sku_normalize import normalize_sku

log = logging.getLogger(__name__)

AMAZON_CHANNEL = "amazon"
MONTH_GRAIN = "month"
MONTH_SKU_GRAIN = "month_sku"


def money(value: float) -> float:
    return round(float(value or 0), 2)


def month_key(period_start: str) -> str:
    return (period_start or "")[:7]


def _cost_map(rows: list[dict]) -> dict[str, float]:
    out: dict[str, float] = {}
    for r in rows:
        sku = normalize_sku(r.get("sku") or "")
        if not sku or sku == "UNKNOWN":
            continue
        out[sku] = float(r.get("cogs_per_unit") or 0)
    return out


def compute_monthly_from_rows(
    sku_rows: list[dict],
    costs: dict[str, float],
    ads_by_month: dict[str, float],
    ads_days_by_month: dict[str, int],
    *,
    referral_pct: float = DEFAULT_REFERRAL_PCT,
    fba_per_unit: float = DEFAULT_FBA_FEE_PER_UNIT,
    as_of: date | None = None,
) -> dict:
    """Pure monthly contribution. No I/O.

    `sku_rows` are `sales_by_sku` dicts (Amazon only — others are skipped).
    Returns account months, per-SKU months, and coverage metadata.
    """
    by_month_sku: dict[tuple[str, str], dict] = {}
    titles: dict[str, str] = {}

    for r in sku_rows:
        if (r.get("channel") or "").lower() != AMAZON_CHANNEL:
            continue
        ym = month_key(r.get("period_start") or "")
        sku = normalize_sku(r.get("sku") or "")
        if len(ym) != 7 or not sku or sku == "UNKNOWN":
            continue
        key = (ym, sku)
        bucket = by_month_sku.get(key)
        if bucket is None:
            bucket = {"units": 0, "gross_sales": 0.0, "period_start": (r.get("period_start") or "")[:10]}
            by_month_sku[key] = bucket
        bucket["units"] += int(r.get("units") or 0)
        bucket["gross_sales"] += float(r.get("gross_sales") or 0)
        title = r.get("product_title") or ""
        if title and (sku not in titles or len(title) > len(titles[sku])):
            titles[sku] = title

    costs = {normalize_sku(k): float(v) for k, v in costs.items() if normalize_sku(k) != "UNKNOWN"}
    avg_cogs = (sum(costs.values()) / len(costs)) if costs else 0.0
    missing: set[str] = set()

    sku_out: list[dict] = []
    month_acc: dict[str, dict] = {}

    for (ym, sku), b in sorted(by_month_sku.items()):
        units = int(b["units"])
        sales = money(b["gross_sales"])
        unit_cost = costs.get(sku)
        if unit_cost is None:
            missing.add(sku)
            unit_cost = avg_cogs
        cogs = money(units * unit_cost)
        referral = money(sales * referral_pct)
        fba = money(units * fba_per_unit)
        contrib = money(sales - referral - fba - cogs)
        period_start = b["period_start"] or f"{ym}-01"
        sku_out.append({
            "date": period_start,
            "grain": MONTH_SKU_GRAIN,
            "sku": sku,
            "channel": AMAZON_CHANNEL,
            "gross_sales": sales,
            "units": units,
            "ad_spend": 0,
            "est_referral_fees": referral,
            "est_fba_fees": fba,
            "est_cogs": cogs,
            "est_contribution": contrib,
            "amazon_net_proceeds": None,
            "net_after_ads": contrib,
            "status": "preliminary",
            "product_title": titles.get(sku),
            "meta": {
                "formula": "gross_sales - referral - fba - cogs",
                "fees_basis": "estimated",
                "cogs_basis": "sku_units_x_sku_costs",
                "sales_basis": "sales_by_sku",
                "ads_basis": "unallocated",
                "source": "sku_monthly",
            },
        })
        acc = month_acc.get(ym)
        if acc is None:
            acc = {
                "date": period_start,
                "sales": 0.0, "units": 0, "referral": 0.0, "fba": 0.0, "cogs": 0.0,
            }
            month_acc[ym] = acc
        acc["sales"] = money(acc["sales"] + sales)
        acc["units"] += units
        acc["referral"] = money(acc["referral"] + referral)
        acc["fba"] = money(acc["fba"] + fba)
        acc["cogs"] = money(acc["cogs"] + cogs)

    account_out: list[dict] = []
    for ym, acc in sorted(month_acc.items()):
        ads_known = int(ads_days_by_month.get(ym, 0) or 0) > 0
        ads = money(ads_by_month.get(ym, 0.0)) if ads_known else 0.0
        contrib = money(acc["sales"] - acc["referral"] - acc["fba"] - ads - acc["cogs"])
        account_out.append({
            "date": acc["date"],
            "grain": MONTH_GRAIN,
            "sku": "",
            "channel": AMAZON_CHANNEL,
            "gross_sales": acc["sales"],
            "units": acc["units"],
            "ad_spend": ads,
            "est_referral_fees": acc["referral"],
            "est_fba_fees": acc["fba"],
            "est_cogs": acc["cogs"],
            "est_contribution": contrib,
            "amazon_net_proceeds": None,
            "net_after_ads": contrib,
            "status": "preliminary",
            "meta": {
                "formula": "gross_sales - referral - fba - ad_spend - cogs",
                "fees_basis": "estimated",
                "cogs_basis": "sku_units_x_sku_costs",
                "sales_basis": "sales_by_sku",
                "ads_basis": "known" if ads_known else "unknown",
                "source": "sku_monthly",
                "ads_days": int(ads_days_by_month.get(ym, 0) or 0),
            },
        })

    months = [r["date"][:7] for r in account_out]
    return {
        "months": account_out,
        "skus": sku_out,
        "month_count": len(account_out),
        "sku_row_count": len(sku_out),
        "coverage_min": months[0] if months else None,
        "coverage_max": months[-1] if months else None,
        "missing_cost_skus": sorted(missing),
        "referral_pct": referral_pct,
        "fba_per_unit": fba_per_unit,
        "as_of": as_of.isoformat() if as_of else None,
        "total_sales": money(sum(r["gross_sales"] for r in account_out)),
        "total_ads": money(sum(r["ad_spend"] for r in account_out)),
        "total_cogs": money(sum(r["est_cogs"] for r in account_out)),
        "total_fees": money(sum(r["est_referral_fees"] + r["est_fba_fees"] for r in account_out)),
        "total_contribution": money(sum(r["net_after_ads"] for r in account_out)),
        "ads_known_months": sum(1 for r in account_out if r["meta"]["ads_basis"] == "known"),
        "ads_unknown_months": sum(1 for r in account_out if r["meta"]["ads_basis"] == "unknown"),
    }


def _ads_by_month() -> tuple[dict[str, float], dict[str, int]]:
    spend: dict[str, float] = defaultdict(float)
    days: dict[str, set[str]] = defaultdict(set)
    for r in fetch_all("ads_campaigns_daily"):
        d = r.get("date") or ""
        ym = month_key(d)
        if len(ym) != 7:
            continue
        spend[ym] += float(r.get("spend") or 0)
        days[ym].add(d)
    return {k: money(v) for k, v in spend.items()}, {k: len(v) for k, v in days.items()}


def compute_monthly_pnl(persist: bool = True) -> dict:
    """Read warehouse tables and optionally store grain=month / month_sku rows."""
    as_of = amazon_as_of()
    sku_rows = [
        r for r in fetch_all("sales_by_sku")
        if (r.get("channel") or "").lower() == AMAZON_CHANNEL
        and (r.get("source") or AMAZON_PULSE_SOURCE) == AMAZON_PULSE_SOURCE
    ]
    try:
        costs = _cost_map(fetch_all("sku_costs"))
    except Exception:
        log.exception("Could not read sku_costs")
        costs = {}
    ads_by_month, ads_days = _ads_by_month()

    result = compute_monthly_from_rows(
        sku_rows, costs, ads_by_month, ads_days, as_of=as_of,
    )

    if not persist or not result["months"]:
        result["inserted"] = 0
        result["sku_inserted"] = 0
        return result

    def _store(rows: list[dict]) -> int:
        payload = []
        for r in rows:
            row = dict(r)
            meta = row.pop("meta", {})
            row.pop("product_title", None)
            row["meta"] = json.dumps(meta)
            payload.append(row)
        written = 0
        for i in range(0, len(payload), 500):
            written += upsert_rows(
                "pnl_daily", payload[i:i + 500],
                on_conflict="date,grain,sku,channel",
            )
        return written

    result["inserted"] = _store(result["months"])
    result["sku_inserted"] = _store(result["skus"])
    if result["missing_cost_skus"]:
        log.warning("No sku_costs entry for %d SKUs; used average unit cost: %s",
                    len(result["missing_cost_skus"]), result["missing_cost_skus"][:8])
    return result
