"""Per-SKU holiday surge from prior-year Nov–Dec sales.

Lip balm (and similar) can run 2–4.5× summer velocity in Nov–Dec.
Account-level seasonality understates that for surge SKUs and flat V30
DOS/reorder on the inventory page ignores it entirely when holiday_mode
is on.

This module:
  1. Reads sales_by_sku for prior-year Jun–Aug vs Nov–Dec
  2. Computes surge, YoY growth vs current V30, and planning_u_30
  3. Upserts onto sku_velocity
  4. Writes per-SKU peak-week floors into seasonality_weekly

Planning rate (when holiday_mode or peak window):
  planning_u_30 = max(V30, holiday_prior_daily * yoy_growth_mult)
  where yoy = clamp(V30 / summer_prior_daily, 0.75, 1.40)
  and surge SKUs only (surge > 1); otherwise planning_u_30 = V30.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import date

from src.db import fetch_all, upsert_rows

log = logging.getLogger(__name__)

# ISO weeks treated as holiday peak (Nov–Jan)
PEAK_WEEKS = frozenset(range(44, 53)) | frozenset(range(1, 6))

YOY_FLOOR = 0.75
YOY_CAP = 1.40
SURGE_FLOOR = 0.40
SURGE_CAP = 6.0
MIN_SUMMER_UNITS = 30
MIN_HOLIDAY_UNITS = 20


def normalize_sku(sku: str | None) -> str:
    """Case-insensitive SKU key (sales_by_sku uses SHOP, velocity uses Shop)."""
    return (sku or "").strip().casefold()


def _days_inclusive(start: date, end: date) -> int:
    return max((end - start).days + 1, 1)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def planning_daily(
    v30: float,
    holiday_prior_daily: float,
    summer_prior_daily: float,
    surge_mult: float,
    *,
    holiday_mode: bool = False,
) -> float:
    """Holiday-aware units/day for DOS, reorder, and capacity.

    Non-surge SKUs (deodorant, balms) keep flat V30 — do not deflate cover.
    Surge SKUs use max(V30, prior holiday daily × YoY) when holiday_mode.
    """
    v30 = float(v30 or 0)
    if not holiday_mode or surge_mult <= 1.0 or holiday_prior_daily <= 0:
        return round(v30, 2)

    if summer_prior_daily > 0.01:
        yoy = _clamp(v30 / summer_prior_daily, YOY_FLOOR, YOY_CAP)
    else:
        yoy = 1.0
    anchored = holiday_prior_daily * yoy
    return round(max(v30, anchored), 2)


def compute_surge_from_sales(
    prior_year: int | None = None,
    holiday_mode: bool | None = None,
) -> dict:
    """Compute per-SKU holiday surge from sales_by_sku and patch sku_velocity.

    Returns summary stats + per-SKU rows (also upserted).
    """
    today = date.today()
    # Holiday season we are planning for: prior calendar year's Nov–Dec
    py = prior_year or (today.year - 1)
    summer_start = date(py, 6, 1)
    summer_end = date(py, 8, 31)
    holiday_start = date(py, 11, 1)
    holiday_end = date(py, 12, 31)
    summer_days = _days_inclusive(summer_start, summer_end)
    holiday_days = _days_inclusive(holiday_start, holiday_end)

    if holiday_mode is None:
        holiday_mode = _load_holiday_mode()

    # Aggregate monthly sales by normalized SKU
    # Prefer amazon_spapi / Amazon channel rows; include all if needed.
    monthly: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # also keep a display sku (prefer velocity casing later)
    display_sku: dict[str, str] = {}

    try:
        rows = fetch_all("sales_by_sku")
    except Exception as e:
        log.exception("Failed to read sales_by_sku: %s", e)
        return {"error": str(e), "skus": 0}

    for r in rows:
        ps = r.get("period_start")
        if not ps:
            continue
        if isinstance(ps, str):
            ps = date.fromisoformat(ps[:10])
        if ps.year != py and not (ps.year == py + 1 and ps.month == 1):
            # only prior-year summer + Nov–Dec (Jan unused for surge ratio)
            if not (summer_start <= ps <= holiday_end):
                continue
        if not (summer_start <= ps <= holiday_end):
            continue

        sku_raw = (r.get("sku") or "").strip()
        if not sku_raw:
            continue
        key = normalize_sku(sku_raw)
        display_sku.setdefault(key, sku_raw)
        units = int(r.get("units") or 0)
        if units <= 0:
            continue

        if summer_start <= ps <= summer_end:
            monthly[key]["summer"] += units
        elif holiday_start <= ps <= holiday_end:
            monthly[key]["holiday"] += units

    # Map velocity rows (canonical SKU casing for upsert)
    vel_rows = []
    try:
        vel_rows = fetch_all("sku_velocity")
    except Exception as e:
        log.warning("sku_velocity read failed: %s", e)

    vel_by_norm: dict[str, dict] = {}
    for v in vel_rows:
        vel_by_norm[normalize_sku(v.get("sku"))] = v

    # Account peak mult (for scaling per-SKU peak floors)
    account_peak_avg = _account_peak_avg()

    updates: list[dict] = []
    seasonality_rows: list[dict] = []
    surge_skus = 0

    # Union: velocity SKUs + sales SKUs with holiday volume
    all_keys = set(vel_by_norm) | {
        k for k, u in monthly.items()
        if u.get("holiday", 0) >= MIN_HOLIDAY_UNITS
    }

    for key in sorted(all_keys):
        vel = vel_by_norm.get(key, {})
        sku = vel.get("sku") or display_sku.get(key) or key
        summer_u = monthly.get(key, {}).get("summer", 0)
        holiday_u = monthly.get(key, {}).get("holiday", 0)

        summer_daily = summer_u / summer_days if summer_u else 0.0
        holiday_daily = holiday_u / holiday_days if holiday_u else 0.0

        if summer_u >= MIN_SUMMER_UNITS and holiday_u >= MIN_HOLIDAY_UNITS:
            surge = _clamp(holiday_daily / summer_daily, SURGE_FLOOR, SURGE_CAP)
        elif holiday_u >= MIN_HOLIDAY_UNITS and summer_u < MIN_SUMMER_UNITS:
            # New SKU with holiday history but thin summer — treat as mild surge
            surge = 1.0
        else:
            surge = 1.0

        v30 = float(vel.get("total_u_30") or 0)
        if summer_daily > 0.01 and v30 > 0:
            yoy = _clamp(v30 / summer_daily, YOY_FLOOR, YOY_CAP)
        else:
            yoy = 1.0

        # Always store holiday-anchored planning rate; UI / holiday_mode chooses
        # whether to use it vs flat V30 for DOS/reorder.
        holiday_plan = planning_daily(
            v30, holiday_daily, summer_daily, surge, holiday_mode=True,
        )

        if surge > 1.05:
            surge_skus += 1

        row = {
            "sku": sku,
            "asin": vel.get("asin"),
            "product_name": vel.get("product_name"),
            "as_of_date": vel.get("as_of_date") or today.isoformat(),
            "amazon_u_7": vel.get("amazon_u_7", 0),
            "amazon_u_14": vel.get("amazon_u_14", 0),
            "amazon_u_30": vel.get("amazon_u_30", 0),
            "amazon_u_90": vel.get("amazon_u_90", 0),
            "shopify_u_7": vel.get("shopify_u_7", 0),
            "shopify_u_14": vel.get("shopify_u_14", 0),
            "shopify_u_30": vel.get("shopify_u_30", 0),
            "shopify_u_90": vel.get("shopify_u_90", 0),
            "total_u_7": vel.get("total_u_7", 0),
            "total_u_14": vel.get("total_u_14", 0),
            "total_u_30": vel.get("total_u_30", 0),
            "total_u_90": vel.get("total_u_90", 0),
            "seasonality_mult": vel.get("seasonality_mult", 1.0),
            "seasonal_total_u_30": (
                round(holiday_plan, 2) if surge > 1.0 and holiday_plan > 0
                else vel.get("seasonal_total_u_30", 0)
            ),
            "holiday_surge_mult": round(surge, 3),
            "holiday_prior_daily": round(holiday_daily, 2),
            "summer_prior_daily": round(summer_daily, 2),
            "yoy_growth_mult": round(yoy, 3),
            "planning_u_30": round(holiday_plan, 2),
            "holiday_nov_dec_units": int(holiday_u),
            "holiday_prior_year": py,
        }
        updates.append(row)

        # Per-SKU peak-week floors in seasonality_weekly (year=0)
        if surge > 1.05 and account_peak_avg > 0:
            for wk in PEAK_WEEKS:
                # Scale account shape so peak-week average ≈ surge
                # Fallback flat surge if no account curve
                seasonality_rows.append({
                    "year": 0,
                    "week": wk,
                    "sku": sku,
                    "multiplier": round(surge, 3),
                    "units_actual": round(holiday_daily * 7, 1),
                    "baseline_units": round(summer_daily * 7, 1),
                })

    inserted = 0
    if updates:
        # Upsert only surge columns + planning — but PostgREST upsert needs full PK.
        # We send full rows reconstructed from velocity to avoid nulling other fields.
        try:
            inserted = upsert_rows("sku_velocity", updates, on_conflict="sku")
        except Exception as e:
            log.exception("Failed to upsert sku_velocity holiday fields: %s", e)
            return {"error": str(e), "skus": 0}

    seas_n = 0
    if seasonality_rows:
        try:
            seas_n = upsert_rows(
                "seasonality_weekly", seasonality_rows, on_conflict="year,week,sku",
            )
        except Exception as e:
            log.warning("Failed to upsert per-SKU seasonality: %s", e)

    top = sorted(
        [u for u in updates if u["holiday_surge_mult"] > 1.05],
        key=lambda r: -r["holiday_surge_mult"],
    )[:10]

    return {
        "prior_year": py,
        "holiday_mode": holiday_mode,
        "skus_updated": inserted or len(updates),
        "surge_skus": surge_skus,
        "seasonality_rows": seas_n or len(seasonality_rows),
        "summer_days": summer_days,
        "holiday_days": holiday_days,
        "top_surge": [
            {
                "sku": t["sku"],
                "surge": t["holiday_surge_mult"],
                "holiday_daily": t["holiday_prior_daily"],
                "summer_daily": t["summer_prior_daily"],
                "planning_u_30": t["planning_u_30"],
                "v30": t["total_u_30"],
                "yoy": t["yoy_growth_mult"],
                "nov_dec_units": t["holiday_nov_dec_units"],
            }
            for t in top
        ],
    }


def holiday_demand_units(
    holiday_prior_daily: float,
    yoy_growth_mult: float,
    days: int = 61,
) -> int:
    """YoY-anchored Nov+Dec unit demand (default 61 days)."""
    if holiday_prior_daily <= 0:
        return 0
    yoy = _clamp(float(yoy_growth_mult or 1.0), YOY_FLOOR, YOY_CAP)
    return int(math.ceil(holiday_prior_daily * yoy * days))


def _load_holiday_mode() -> bool:
    try:
        rows = fetch_all("inventory_settings")
        if rows:
            return bool(rows[0].get("holiday_mode", False))
    except Exception:
        pass
    return False


def _account_peak_avg() -> float:
    try:
        rows = fetch_all("seasonality_weekly")
        peaks = [
            float(r["multiplier"])
            for r in rows
            if r.get("sku") == "_account_"
            and r.get("year") == 0
            and int(r.get("week") or 0) in PEAK_WEEKS
        ]
        if peaks:
            return sum(peaks) / len(peaks)
    except Exception:
        pass
    return 0.0
