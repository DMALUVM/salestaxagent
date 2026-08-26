"""Per-SKU holiday surge from prior-year Nov–Dec sales.

Lip balm can run 2–4.5× summer velocity in Nov–Dec. Aug/Sep is the
annual trough — never use depressed V30 alone as the planning baseline.

Policy:
  - Amazon FBA must stay ≥ AMAZON_MIN_COVER_DAYS (60) at holiday-aware
    planning velocity at all times.
  - planning_u_30 anchors to prior Nov–Dec × YoY (surge SKUs) or a
    trough-resistant baseline (everyone else).
  - YoY / baseline use max(V90, summer_prior), not Aug/Sep V30.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, upsert_rows

log = logging.getLogger(__name__)

# ISO weeks treated as holiday peak (Nov–Jan)
PEAK_WEEKS = frozenset(range(44, 53)) | frozenset(range(1, 6))

# Aug + Sep = annual trough — do not trust V30 alone
SLOW_MONTHS = frozenset({8, 9})

AMAZON_MIN_COVER_DAYS = 60
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


def is_slow_season(today: date | None = None) -> bool:
    """True in Aug/Sep — slowest sales months; V30 is a trough."""
    d = today or date.today()
    return d.month in SLOW_MONTHS


def approaching_peak(
    today: date | None = None,
    peak_start: date | None = None,
    lead_days: int = 45,
) -> bool:
    """True when within lead_days of peak window (or already in peak)."""
    d = today or date.today()
    if peak_start is None:
        # Default: Oct 1 of current year (or next if past Jan peak end)
        peak_start = date(d.year, 10, 1)
        if d.month <= 1:
            peak_start = date(d.year - 1, 10, 1)
    return d >= peak_start - timedelta(days=lead_days)


def normalized_baseline(
    v30: float,
    v90: float = 0.0,
    summer_prior_daily: float = 0.0,
    today: date | None = None,
) -> float:
    """Trough-resistant daily baseline.

    Always take the strongest of V30 / V90 / prior summer. In Aug/Sep the
    trough V30 loses automatically; a strong current V30 still wins.
    Never let depressed Aug/Sep V30 alone set the rate.
    """
    v30 = float(v30 or 0)
    v90 = float(v90 or 0)
    summer = float(summer_prior_daily or 0)
    return round(max(v30, v90, summer), 2)


def planning_daily(
    v30: float,
    holiday_prior_daily: float,
    summer_prior_daily: float,
    surge_mult: float,
    *,
    v90: float = 0.0,
    holiday_mode: bool = False,
    today: date | None = None,
    force_holiday_plan: bool = False,
) -> float:
    """Holiday-aware units/day for Amazon DOS / reorder / capacity.

    Always trough-resistant. For surge SKUs, anchors to prior Nov–Dec × YoY
    (YoY vs summer using normalized baseline, not Aug/Sep V30).

    Non-surge SKUs: normalized baseline (do not deflate with surge < 1).
    """
    baseline = normalized_baseline(v30, v90, summer_prior_daily, today=today)
    surge_mult = float(surge_mult or 1.0)
    holiday_prior_daily = float(holiday_prior_daily or 0)
    summer_prior_daily = float(summer_prior_daily or 0)

    use_holiday = force_holiday_plan or holiday_mode or is_slow_season(today)
    if not use_holiday:
        # Still store a sensible rate; callers decide when to apply
        use_holiday = True  # planning_u_30 is always the cover demand rate

    if surge_mult <= 1.0 or holiday_prior_daily <= 0:
        return round(max(baseline, float(v30 or 0)), 2)

    if summer_prior_daily > 0.01 and baseline > 0:
        yoy = _clamp(baseline / summer_prior_daily, YOY_FLOOR, YOY_CAP)
    else:
        yoy = 1.0

    # holiday × capped YoY — do NOT also multiply baseline×surge (bypasses YoY cap)
    anchored = holiday_prior_daily * yoy
    return round(max(baseline, anchored), 2)


def amazon_cover_target(
    target_cover_days: int = 60,
    holiday_mode: bool = False,
) -> int:
    """Amazon FBA cover target — never below 60 days."""
    t = int(target_cover_days or AMAZON_MIN_COVER_DAYS)
    if holiday_mode:
        t = max(t, 90)
    return max(AMAZON_MIN_COVER_DAYS, t)


def amazon_demand_daily(vel: dict, *, today: date | None = None) -> float:
    """Units/day for Amazon cover math from a sku_velocity row."""
    plan = float(vel.get("planning_u_30") or 0)
    v30 = float(vel.get("total_u_30") or 0)
    v90 = float(vel.get("total_u_90") or 0)
    summer = float(vel.get("summer_prior_daily") or 0)
    surge = float(vel.get("holiday_surge_mult") or 1)
    holiday = float(vel.get("holiday_prior_daily") or 0)

    if plan > 0:
        # Recompute if stored plan looks like it was V30-only in a trough
        recomputed = planning_daily(
            v30, holiday, summer, surge, v90=v90, today=today, force_holiday_plan=True,
        )
        return max(plan, recomputed)

    return planning_daily(
        v30, holiday, summer, surge, v90=v90, today=today, force_holiday_plan=True,
    )


def compute_surge_from_sales(
    prior_year: int | None = None,
    holiday_mode: bool | None = None,
) -> dict:
    """Compute per-SKU holiday surge from sales_by_sku and patch sku_velocity."""
    today = date.today()
    py = prior_year or (today.year - 1)
    summer_start = date(py, 6, 1)
    summer_end = date(py, 8, 31)
    holiday_start = date(py, 11, 1)
    holiday_end = date(py, 12, 31)
    summer_days = _days_inclusive(summer_start, summer_end)
    holiday_days = _days_inclusive(holiday_start, holiday_end)

    if holiday_mode is None:
        holiday_mode = _load_holiday_mode()

    monthly: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
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

    vel_rows = []
    try:
        vel_rows = fetch_all("sku_velocity")
    except Exception as e:
        log.warning("sku_velocity read failed: %s", e)

    vel_by_norm: dict[str, dict] = {}
    for v in vel_rows:
        vel_by_norm[normalize_sku(v.get("sku"))] = v

    account_peak_avg = _account_peak_avg()

    updates: list[dict] = []
    seasonality_rows: list[dict] = []
    surge_skus = 0

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
        else:
            surge = 1.0

        v30 = float(vel.get("total_u_30") or 0)
        v90 = float(vel.get("total_u_90") or 0)
        baseline = normalized_baseline(v30, v90, summer_daily, today=today)

        if summer_daily > 0.01 and baseline > 0:
            yoy = _clamp(baseline / summer_daily, YOY_FLOOR, YOY_CAP)
        else:
            yoy = 1.0

        holiday_plan = planning_daily(
            v30, holiday_daily, summer_daily, surge,
            v90=v90, today=today, force_holiday_plan=True,
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
                round(holiday_plan, 2) if holiday_plan > 0
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

        if surge > 1.05 and account_peak_avg > 0:
            for wk in PEAK_WEEKS:
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
        "slow_season": is_slow_season(today),
        "amazon_min_cover_days": AMAZON_MIN_COVER_DAYS,
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
                "v90": t["total_u_90"],
                "yoy": t["yoy_growth_mult"],
                "nov_dec_units": t["holiday_nov_dec_units"],
                "cover_60d_units": int(math.ceil(t["planning_u_30"] * AMAZON_MIN_COVER_DAYS)),
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
