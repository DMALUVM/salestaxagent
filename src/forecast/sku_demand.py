"""SKU demand forecast engine.

Builds a weekly demand projection for a single SKU from today through
a target end date using all available data sources.

Three-method cross-check:
  A) Naive run-rate: V30 velocity × weeks
  B) Seasonal+YoY: velocity adjusted by 52-week seasonal multipliers
     + holiday forecast overlay
  C) SnS floor + organic: subscription shipped baseline + non-sub demand

Coverage = expected units × (1 + safety_pct)
"""
from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from src.db import fetch_all

log = logging.getLogger(__name__)


def _load_asin_titles() -> dict[str, str]:
    try:
        p = Path(__file__).resolve().parent.parent.parent / "config" / "asin_titles.json"
        if p.exists():
            return json.loads(p.read_text())
    except Exception:
        pass
    return {}


def _iso_week(d: date) -> int:
    """ISO week number clamped to 1-52."""
    return max(1, min(52, d.isocalendar()[1]))


def forecast_sku(
    sku: str,
    end_date: str,
    start_date: str | None = None,
    safety_pct: float = 0.15,
) -> dict:
    """Build demand forecast for a single SKU.

    Returns dict with expected_units, coverage_units, method breakdown,
    weekly series, confidence, and data quality info.
    """
    today = date.today()
    start = date.fromisoformat(start_date) if start_date else today
    end = date.fromisoformat(end_date)

    if end <= start:
        return {"error": "end_date must be after start_date"}

    # ── Load data sources ──
    vel_rows = fetch_all("sku_velocity")
    vel = next((v for v in vel_rows if v.get("sku") == sku), None)

    seas_rows = fetch_all("seasonality_weekly")
    seasonality = {r["week"]: float(r["multiplier"])
                   for r in seas_rows if r.get("sku") == "_account_" and r.get("year") == 0}

    fc_rows = fetch_all("forecast_weekly")
    holiday_fc: dict[str, float] = {}
    for r in fc_rows:
        if r.get("sku") == sku and r.get("scenario") == "correction_factor":
            ws = str(r.get("week_start", ""))[:10]
            holiday_fc[ws] = float(r.get("units", 0) or 0)
    # Remap 2026-01 → 2027-01 (January following holiday season)
    if "2026-01" in str(list(holiday_fc.keys())):
        remapped = {}
        for k, v in holiday_fc.items():
            remapped["2027" + k[4:] if k.startswith("2026-01") else k] = v
        holiday_fc = remapped

    sns_offers = [r for r in fetch_all("sns_offer_metrics")
                  if r.get("sku") == sku or r.get("asin") == (vel.get("asin") if vel else "")]

    ret_rows = [r for r in fetch_all("fba_returns") if r.get("sku") == sku]

    # ASIN + product name
    asin = vel.get("asin", "") if vel else ""
    titles = _load_asin_titles()
    product_name = (vel.get("product_name") if vel else None) or titles.get(asin, sku)

    # ── Velocity (daily rates — fields are already u/day) ──
    v7 = float(vel.get("total_u_7", 0) or 0) if vel else 0
    v30 = float(vel.get("total_u_30", 0) or 0) if vel else 0
    v90 = float(vel.get("total_u_90", 0) or 0) if vel else 0

    # Blended daily velocity (50/30/20 weights)
    windows = [(v7, 0.50), (v30, 0.30), (v90, 0.20)]
    valid_vel = [(r, w) for r, w in windows if r > 0]
    if valid_vel:
        w_sum = sum(w for _, w in valid_vel)
        blended_daily = sum(r * w / w_sum for r, w in valid_vel)
    else:
        blended_daily = 0

    # SnS metrics
    sns_weekly_shipped = 0
    sns_active_subs = 0
    if sns_offers:
        # Use latest offer row
        latest_sns = max(sns_offers, key=lambda r: r.get("week_start", ""))
        sns_weekly_shipped = int(latest_sns.get("shipped_units", 0) or 0)
        sns_active_subs = int(latest_sns.get("active_subscriptions", 0) or 0)

    # Return rate
    total_returns = sum(int(r.get("quantity", 1)) for r in ret_rows)
    return_rate = 0.0
    if v30 > 0 and total_returns > 0:
        # Approximate: returns over ~90 days vs units sold in 90 days
        return_rate = min(total_returns / max(v90 * 90, 1), 0.20)

    # ── Build weekly series ──
    weeks: list[dict] = []
    cursor = start
    while cursor < end:
        week_end = min(cursor + timedelta(days=6), end)
        iw = _iso_week(cursor)
        ws_iso = cursor.isoformat()

        # Check for holiday forecast override
        fc_match = None
        for offset in range(-3, 4):
            test = (cursor + timedelta(days=offset)).isoformat()
            if test in holiday_fc:
                fc_match = holiday_fc[test]
                break

        # Seasonal multiplier
        mult = seasonality.get(iw, 1.0)

        # Method A: naive (blended velocity × 7)
        naive = blended_daily * 7

        # Method B: seasonal + holiday
        if fc_match is not None:
            seasonal = fc_match
            source = "forecast"
        else:
            seasonal = blended_daily * 7 * mult
            source = "velocity×seasonality"

        # Method C: SnS floor + organic residual
        organic_daily = max(blended_daily - (sns_weekly_shipped / 7 if sns_weekly_shipped else 0), 0)
        sns_floor = sns_weekly_shipped
        organic = organic_daily * 7 * mult
        method_c = sns_floor + organic

        # Best estimate: use seasonal (method B) as primary
        best = seasonal

        days_in_week = (week_end - cursor).days + 1
        if days_in_week < 7:
            # Partial week at end of horizon
            best = best * days_in_week / 7
            naive = naive * days_in_week / 7
            method_c = method_c * days_in_week / 7

        weeks.append({
            "week_start": ws_iso,
            "week_end": week_end.isoformat(),
            "iso_week": iw,
            "days": days_in_week,
            "naive": round(naive),
            "seasonal": round(best),
            "sns_organic": round(method_c),
            "source": source,
            "multiplier": round(mult, 2),
        })

        cursor = week_end + timedelta(days=1)

    # ── Aggregate ──
    total_naive = sum(w["naive"] for w in weeks)
    total_seasonal = sum(w["seasonal"] for w in weeks)
    total_sns_organic = sum(w["sns_organic"] for w in weeks)

    # Spread check
    methods = [total_naive, total_seasonal, total_sns_organic]
    avg_methods = sum(methods) / len(methods) if methods else 0
    max_spread = max(abs(m - avg_methods) / max(avg_methods, 1) for m in methods) * 100 if avg_methods else 0

    # ── Load calibrated weights from model_state ──
    model_version = "default"
    weights = {"a": 0.15, "b": 0.60, "c": 0.25}
    try:
        model_rows = fetch_all("forecast_model_state")
        sku_model = next((m for m in model_rows if m.get("sku") == sku), None)
        global_model = next((m for m in model_rows if m.get("sku") == "*"), None)
        active = sku_model or global_model
        if active:
            w = active.get("weights")
            if isinstance(w, str):
                w = json.loads(w)
            if isinstance(w, dict) and "a" in w:
                weights = w
                model_version = active.get("model_version", "calibrated")
    except Exception:
        pass  # table may not exist yet

    # Blended expected using calibrated weights
    expected = round(
        weights.get("a", 0.15) * total_naive
        + weights.get("b", 0.60) * total_seasonal
        + weights.get("c", 0.25) * total_sns_organic
    )
    coverage = math.ceil(expected * (1 + safety_pct))

    # Bands
    band_pct = 0.20
    low = math.floor(expected * (1 - band_pct))
    high = math.ceil(expected * (1 + band_pct))

    # Data quality
    weeks_of_vel = sum(1 for w in [v7, v30, v90] if w > 0)
    has_holiday_fc = len(holiday_fc) > 0
    has_sns = sns_active_subs > 0

    # Holiday windows inside range
    holidays: list[str] = []
    if any(w["source"] == "forecast" for w in weeks):
        holidays.append("Holiday forecast (Nov-Jan) applied")
    for w in weeks:
        if w["multiplier"] > 2.0:
            holidays.append(f"Week {w['iso_week']}: {w['multiplier']}x seasonal peak")
            break

    return {
        "sku": sku,
        "asin": asin,
        "product_name": product_name,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "num_weeks": len(weeks),
        "safety_pct": safety_pct,

        "expected_units": expected,
        "coverage_units": coverage,
        "low_band": low,
        "high_band": high,

        "methods": {
            "A_naive_runrate": total_naive,
            "B_seasonal_yoy": total_seasonal,
            "C_sns_plus_organic": total_sns_organic,
            "spread_pct": round(max_spread, 1),
            "spread_warning": max_spread > 25,
        },

        "breakdown": {
            "blended_daily_velocity": round(blended_daily, 1),
            "sns_weekly_shipped": sns_weekly_shipped,
            "sns_active_subs": sns_active_subs,
            "organic_daily": round(organic_daily, 1),
            "return_rate_pct": round(return_rate * 100, 1),
            "holiday_forecast_weeks": len(holiday_fc),
        },

        "data_quality": {
            "velocity_windows": weeks_of_vel,
            "has_holiday_forecast": has_holiday_fc,
            "has_sns_data": has_sns,
            "seasonality_weeks": len(seasonality),
        },

        "model_version": model_version,
        "weights": weights,

        "holidays": holidays,
        "weeks": weeks,
        "disclaimer": "Planning aid only — not a guarantee. Actual demand may differ materially.",
    }

    # ── Log forecast run ──
    try:
        from src.db import upsert_rows as _upsert
        from src.db import get_client as _gc
        _gc().table("forecast_runs").insert({
            "sku": sku,
            "asin": asin,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "safety_pct": safety_pct,
            "expected_units": expected,
            "coverage_units": coverage,
            "low_units": low,
            "high_units": high,
            "method_a_units": total_naive,
            "method_b_units": total_seasonal,
            "method_c_units": total_sns_organic,
            "primary_method": "blended" if model_version != "default" else "B_seasonal",
            "velocity_upd": round(blended_daily, 1),
            "sns_subs": sns_active_subs,
            "sns_shipped_wk": sns_weekly_shipped,
            "return_rate": round(return_rate, 4),
            "model_version": model_version,
            "source": "cli",
        }).execute()
    except Exception:
        pass  # logging is best-effort

    return result
