"""Forecast reconciliation and calibration.

1. Ingest actuals: weekly units per SKU from velocity/orders
2. Score COMPLETED WEEKS inside any forecast run (open or closed)
3. Calibrate method weights from inverse-MAPE
"""
from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, upsert_rows, get_client

log = logging.getLogger(__name__)

MIN_CALIBRATION_WEEKS = 8
MAX_WEIGHT_SHIFT = 0.20
WEIGHT_FLOOR = 0.05


# ── 1. Actuals ingestion ──

def ingest_actuals(sku: str | None = None) -> dict:
    """Build weekly actuals from real Amazon order data (sales_by_sku).

    Priority:
      1. sales_by_sku (monthly units per SKU from SP-API orders) →
         split into weekly via days-in-month. Source: 'amazon_orders'
      2. velocity_v30 proxy only for SKUs with no order rows.
         Source: 'velocity_proxy'
    """
    today = date.today()

    # Step 1: Real order data from sales_by_sku (monthly, convert to weekly)
    try:
        order_rows = fetch_all("sales_by_sku")
    except Exception:
        order_rows = []

    # Build monthly totals per SKU (case-normalize)
    from collections import defaultdict as _dd
    sku_monthly: dict[str, dict[str, int]] = _dd(lambda: _dd(int))
    sku_case_map: dict[str, str] = {}  # uppercase → original case

    for r in order_rows:
        s = r.get("sku", "")
        if not s:
            continue
        s_upper = s.upper()
        if s_upper not in sku_case_map:
            # Prefer the mixed-case version from velocity if available
            sku_case_map[s_upper] = s
        units = int(r.get("units", 0) or 0)
        ps = r.get("period_start", "")
        if ps and units > 0:
            sku_monthly[s_upper][ps] += units

    if sku:
        target = {sku.upper()}
        sku_monthly = {k: v for k, v in sku_monthly.items() if k in target}

    # Map velocity SKUs for case normalization
    vel_rows = fetch_all("sku_velocity")
    for v in vel_rows:
        s = v.get("sku", "")
        if s:
            sku_case_map[s.upper()] = s

    rows: list[dict] = []
    orders_weeks = 0
    proxy_weeks = 0
    skus_with_orders = set()

    # Convert monthly order data to weekly actuals
    import calendar
    for s_upper, months in sku_monthly.items():
        canonical_sku = sku_case_map.get(s_upper, s_upper)
        skus_with_orders.add(canonical_sku)
        for month_start, total_units in months.items():
            try:
                y, m = int(month_start[:4]), int(month_start[5:7])
            except (ValueError, IndexError):
                continue
            dim = calendar.monthrange(y, m)[1]
            daily = total_units / dim

            # Generate Monday-aligned weeks within this month
            d = date(y, m, 1)
            month_end = date(y, m, dim)
            # Snap to Monday
            monday = d - timedelta(days=d.weekday())
            while monday <= month_end:
                if monday >= today:
                    break
                # Days of this week that fall in this month
                week_end = monday + timedelta(days=6)
                overlap_start = max(monday, date(y, m, 1))
                overlap_end = min(week_end, date(y, m, dim))
                if overlap_start > overlap_end:
                    monday += timedelta(weeks=1)
                    continue
                overlap_days = (overlap_end - overlap_start).days + 1
                week_units = round(daily * overlap_days)
                if week_units > 0:
                    rows.append({
                        "sku": canonical_sku,
                        "week_start": monday.isoformat(),
                        "actual_units": week_units,
                        "source": "amazon_orders",
                    })
                    orders_weeks += 1
                monday += timedelta(weeks=1)

    # Step 2: Velocity proxy for SKUs without order data
    for v in vel_rows:
        s = v.get("sku", "")
        if not s or s in skus_with_orders:
            continue
        if sku and s != sku:
            continue
        v30 = float(v.get("total_u_30", 0) or 0)
        if v30 <= 0:
            continue
        for w in range(52):
            monday = today - timedelta(days=today.weekday()) - timedelta(weeks=w)
            if monday >= today:
                continue
            rows.append({
                "sku": s,
                "week_start": monday.isoformat(),
                "actual_units": round(v30 * 7),
                "source": "velocity_proxy",
            })
            proxy_weeks += 1

    if not rows:
        return {"rows_upserted": 0, "skus": 0, "orders_weeks": 0, "proxy_weeks": 0}

    # Deduplicate: (sku, week_start) — prefer amazon_orders over proxy
    seen: dict[tuple[str, str], dict] = {}
    for r in rows:
        key = (r["sku"], r["week_start"])
        existing = seen.get(key)
        if not existing or (r["source"] == "amazon_orders" and existing["source"] != "amazon_orders"):
            seen[key] = r
        elif existing["source"] == r["source"]:
            existing["actual_units"] += r["actual_units"]  # sum overlapping months
    rows = list(seen.values())

    inserted = upsert_rows("forecast_actuals_weekly", rows,
                           on_conflict="sku,week_start")
    return {
        "rows_upserted": inserted,
        "skus": len(set(r["sku"] for r in rows)),
        "orders_weeks": orders_weeks,
        "proxy_weeks": proxy_weeks,
        "skus_with_orders": len(skus_with_orders),
    }


# ── 2. Reconciliation (week-level scoring) ──

def reconcile(sku: str | None = None) -> dict:
    """Score completed weeks inside forecast runs against actuals.

    For each (run, week) pair where:
      - forecast_run_weeks has a predicted row
      - forecast_actuals_weekly has an actual row
      - week_start is in the past (completed week)
    Compute per-method absolute percentage error.

    Aggregate per SKU into forecast_accuracy.
    """
    client = get_client()
    today = date.today()
    last_monday = today - timedelta(days=today.weekday())

    # Get ALL runs (not just completed — we score individual weeks)
    q = client.table("forecast_runs").select("id,sku")
    if sku:
        q = q.eq("sku", sku)
    runs_resp = q.order("created_at", desc=True).limit(200).execute()
    runs = runs_resp.data or []

    if not runs:
        return {"runs_found": 0, "weeks_scored": 0, "skus_scored": 0,
                "accuracy_rows": 0, "message": "No forecast runs found"}

    run_ids = [r["id"] for r in runs]
    run_skus = {r["id"]: r["sku"] for r in runs}

    # Get predicted weeks — only those before last Monday (completed)
    week_rows_resp = client.table("forecast_run_weeks").select("*") \
        .in_("run_id", run_ids) \
        .lt("week_start", last_monday.isoformat()) \
        .execute()
    predicted_weeks = week_rows_resp.data or []

    if not predicted_weeks:
        return {"runs_found": len(runs), "weeks_scored": 0, "skus_scored": 0,
                "accuracy_rows": 0, "message": "No completed predicted weeks found — run forecasts with past start dates to create scoreable weeks"}

    # Get actuals for the relevant SKUs
    relevant_skus = list(set(run_skus[pw["run_id"]] for pw in predicted_weeks if pw["run_id"] in run_skus))
    actuals_resp = client.table("forecast_actuals_weekly").select("*") \
        .in_("sku", relevant_skus).execute()

    actuals_map: dict[str, dict[str, float]] = defaultdict(dict)
    actuals_source: dict[str, dict[str, str]] = defaultdict(dict)
    for a in (actuals_resp.data or []):
        actuals_map[a["sku"]][a["week_start"]] = float(a["actual_units"])
        actuals_source[a["sku"]][a["week_start"]] = a.get("source", "unknown")

    # Peak weeks (Nov 1 – Jan 31 ≈ ISO weeks 44-52 + 1-5)
    PEAK_WEEKS = frozenset(range(44, 53)) | frozenset(range(1, 6))

    def _iso_week(ds: str) -> int:
        try:
            d = date.fromisoformat(ds)
            return max(1, min(52, d.isocalendar()[1]))
        except (ValueError, TypeError):
            return 26  # mid-year fallback

    # Score each predicted week, split into peak vs offpeak buckets
    sku_week_errors: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"a": [], "b": [], "c": [], "primary": []}
    )
    sku_peak_errors: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"a": [], "b": [], "c": [], "primary": []}
    )
    sku_offpeak_errors: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"a": [], "b": [], "c": [], "primary": []}
    )
    weeks_scored = 0

    for pw in predicted_weeks:
        rid = pw["run_id"]
        s = run_skus.get(rid)
        if not s:
            continue

        ws = pw["week_start"]
        sku_actuals = actuals_map.get(s, {})

        # Fuzzy match: try exact, then ±1..3 days
        actual = sku_actuals.get(ws)
        if actual is None:
            try:
                d = date.fromisoformat(ws)
                for offset in range(1, 4):
                    for sign in [1, -1]:
                        test = (d + timedelta(days=offset * sign)).isoformat()
                        if test in sku_actuals:
                            actual = sku_actuals[test]
                            break
                    if actual is not None:
                        break
            except (ValueError, TypeError):
                pass

        if actual is None or actual <= 0:
            continue

        # Per-method errors, bucketed by season
        iw = _iso_week(ws)
        is_peak = iw in PEAK_WEEKS

        # Determine actuals source for this week
        matched_ws = ws
        src = actuals_source.get(s, {}).get(ws, "unknown")
        if src == "unknown":
            # Check fuzzy-matched date
            try:
                d = date.fromisoformat(ws)
                for off in range(1, 4):
                    for sign in [1, -1]:
                        test = (d + timedelta(days=off * sign)).isoformat()
                        if test in actuals_source.get(s, {}):
                            src = actuals_source[s][test]
                            break
                    if src != "unknown":
                        break
            except (ValueError, TypeError):
                pass

        # Only real order data contributes to PEAK calibration.
        # Proxy data would make naive look artificially accurate in peak.
        use_for_peak = is_peak and src == "amazon_orders"
        bucket = sku_peak_errors if use_for_peak else sku_offpeak_errors

        for method, col in [("a", "method_a"), ("b", "method_b"),
                            ("c", "method_c"), ("primary", "predicted_units")]:
            pred = float(pw.get(col, 0) or 0)
            if pred > 0:
                ape = abs(pred - actual) / actual
                sku_week_errors[s][method].append(ape)
                bucket[s][method].append(ape)

        weeks_scored += 1

    # Build accuracy rows + season-split weights
    accuracy_rows: list[dict] = []
    season_weights: dict[str, dict] = {}  # sku → {peak_weights, offpeak_weights}

    for s, errors in sku_week_errors.items():
        n = len(errors.get("primary", []))
        if n == 0:
            continue

        mape_by_method: dict[str, float] = {}
        for mk in ["a", "b", "c"]:
            errs = errors.get(mk, [])
            if errs:
                mape_by_method[mk] = sum(errs) / len(errs)

        primary_errs = errors.get("primary", [])
        mape = sum(primary_errs) / len(primary_errs) if primary_errs else None

        best = min(mape_by_method, key=lambda k: mape_by_method.get(k, 999)) if mape_by_method else "b"

        # Compute season-split weights
        offpeak_errs = sku_offpeak_errors.get(s, {})
        peak_errs = sku_peak_errors.get(s, {})

        offpeak_mape = {mk: sum(e)/len(e) for mk, e in offpeak_errs.items() if e and mk in ("a","b","c")}
        peak_mape = {mk: sum(e)/len(e) for mk, e in peak_errs.items() if e and mk in ("a","b","c")}

        offpeak_w = _compute_weights(offpeak_mape) if offpeak_mape else {"a": 0.15, "b": 0.60, "c": 0.25}
        peak_w = _compute_weights(peak_mape) if peak_mape else {"a": 0.10, "b": 0.70, "c": 0.20}

        # Store combined for accuracy + model_state
        combined_weights = _compute_weights(mape_by_method) if mape_by_method else offpeak_w
        season_weights[s] = {
            "offpeak_weights": offpeak_w,
            "peak_weights": peak_w,
            "offpeak_weeks": len(offpeak_errs.get("primary", [])),
            "peak_weeks": len(peak_errs.get("primary", [])),
        }

        for window in [30, 90]:
            accuracy_rows.append({
                "sku": s,
                "window_days": window,
                "mape": round(mape * 100, 1) if mape is not None else None,
                "bias": 0,
                "n_weeks": n,
                "best_method": best,
                "method_weights": json.dumps(combined_weights),
            })

    if accuracy_rows:
        upsert_rows("forecast_accuracy", accuracy_rows,
                     on_conflict="sku,window_days")

    return {
        "runs_found": len(runs),
        "weeks_scored": weeks_scored,
        "skus_scored": len(sku_week_errors),
        "accuracy_rows": len(accuracy_rows),
        "season_weights": season_weights,
    }


def _compute_weights(mape_by_method: dict[str, float]) -> dict[str, float]:
    """Inverse-MAPE weighting with floor."""
    if not mape_by_method:
        return {"a": 0.15, "b": 0.60, "c": 0.25}

    inv = {k: 1.0 / max(mape, 0.01) for k, mape in mape_by_method.items()}
    total = sum(inv.values())
    weights = {k: max(v / total, WEIGHT_FLOOR) for k, v in inv.items()}

    # Renormalize after floor
    total = sum(weights.values())
    return {k: round(v / total, 3) for k, v in weights.items()}


# ── 3. Calibration ──

def _cap_weights(old: dict, new: dict, default: dict) -> dict:
    """Apply max shift cap and floor to new weights vs old."""
    capped = {}
    for k in ["a", "b", "c"]:
        o = old.get(k, default.get(k, 0.33))
        n = new.get(k, o)
        delta = max(-MAX_WEIGHT_SHIFT, min(MAX_WEIGHT_SHIFT, n - o))
        capped[k] = round(max(WEIGHT_FLOOR, o + delta), 3)
    total = sum(capped.values())
    return {k: round(v / total, 3) for k, v in capped.items()}


def calibrate(sku: str | None = None,
              season_weights: dict[str, dict] | None = None) -> dict:
    """Update forecast_model_state with season-aware learned weights.

    Stores offpeak weights in 'weights' field (legacy compat) and
    peak weights in 'seasonal_factors.peak_weights'.
    """
    client = get_client()

    q = client.table("forecast_accuracy").select("*")
    if sku:
        q = q.eq("sku", sku)
    acc_rows = (q.execute()).data or []

    if not acc_rows:
        return {"calibrated": 0, "message": "No accuracy data — run forecast-reconcile first"}

    state_resp = client.table("forecast_model_state").select("*").execute()
    current_state: dict[str, dict] = {s["sku"]: s for s in (state_resp.data or [])}

    DEFAULT_OFFPEAK = {"a": 0.15, "b": 0.60, "c": 0.25}
    DEFAULT_PEAK = {"a": 0.10, "b": 0.70, "c": 0.20}

    calibrated = 0
    changes: list[str] = []

    for row in acc_rows:
        s = row["sku"]
        n = row.get("n_weeks", 0) or 0
        if n < MIN_CALIBRATION_WEEKS:
            continue

        existing = current_state.get(s, current_state.get("*", {}))
        old_offpeak = existing.get("weights", DEFAULT_OFFPEAK)
        if isinstance(old_offpeak, str):
            old_offpeak = json.loads(old_offpeak)

        old_sf = existing.get("seasonal_factors")
        if isinstance(old_sf, str):
            old_sf = json.loads(old_sf)
        old_peak = (old_sf or {}).get("peak_weights", DEFAULT_PEAK)

        # Get season-split data from reconcile output
        sw = (season_weights or {}).get(s, {})
        new_offpeak = sw.get("offpeak_weights", old_offpeak)
        new_peak = sw.get("peak_weights", old_peak)
        offpeak_n = sw.get("offpeak_weeks", 0)
        peak_n = sw.get("peak_weeks", 0)

        # Calibrate offpeak only from offpeak weeks
        if offpeak_n >= MIN_CALIBRATION_WEEKS:
            capped_offpeak = _cap_weights(old_offpeak, new_offpeak, DEFAULT_OFFPEAK)
        else:
            capped_offpeak = old_offpeak

        # Calibrate peak only from peak weeks
        if peak_n >= MIN_CALIBRATION_WEEKS:
            capped_peak = _cap_weights(old_peak, new_peak, DEFAULT_PEAK)
        else:
            capped_peak = old_peak  # keep default peak-friendly weights

        version = f"cal-{date.today().isoformat()}"
        upsert_rows("forecast_model_state", [{
            "sku": s,
            "weights": json.dumps(capped_offpeak),
            "seasonal_factors": json.dumps({
                "peak_weights": capped_peak,
                "offpeak_weeks_scored": offpeak_n,
                "peak_weeks_scored": peak_n,
            }),
            "model_version": version,
        }], on_conflict="sku")

        changes.append(
            f"{s}: offpeak={capped_offpeak} ({offpeak_n}wk) "
            f"peak={capped_peak} ({peak_n}wk) MAPE={row.get('mape')}%"
        )
        calibrated += 1

    return {"calibrated": calibrated, "changes": changes}


# ── 4. Full pipeline ──

def run_full_reconcile(sku: str | None = None) -> dict:
    """Ingest actuals → score weeks → calibrate with season split."""
    actuals = ingest_actuals(sku)
    recon = reconcile(sku)
    cal = calibrate(sku, season_weights=recon.get("season_weights"))
    return {"actuals": actuals, "reconciliation": recon, "calibration": cal}
