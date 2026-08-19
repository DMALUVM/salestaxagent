"""Forecast reconciliation and calibration.

1. Ingest actuals: weekly units per SKU from velocity/orders data
2. Score past forecasts: MAPE/bias per method vs actuals
3. Calibrate weights: inverse-MAPE weighting with safety bounds
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
MAX_WEIGHT_SHIFT = 0.20  # max change per calibration cycle
WEIGHT_FLOOR = 0.05      # no method goes below 5%


# ── 1. Actuals ingestion ──

def ingest_actuals(sku: str | None = None) -> dict:
    """Build weekly actuals from velocity daily rates.

    For each SKU in sku_velocity, derive weekly units from the V30 daily
    rate (already units/day) × 7.  This is an approximation — true
    per-SKU daily sales aren't stored, but V30 is recalculated daily
    from actual SP-API orders.

    For past weeks we use the V30 at compute time as the best available
    proxy.  Future improvement: log daily per-SKU units during sales sync.
    """
    vel_rows = fetch_all("sku_velocity")
    if sku:
        vel_rows = [v for v in vel_rows if v.get("sku") == sku]

    today = date.today()
    rows: list[dict] = []

    for v in vel_rows:
        s = v.get("sku")
        if not s:
            continue
        v30 = float(v.get("total_u_30", 0) or 0)
        if v30 <= 0:
            continue

        # Generate weekly actuals for the last 13 weeks
        for w in range(13):
            monday = today - timedelta(days=today.weekday()) - timedelta(weeks=w)
            if monday >= today:
                continue
            rows.append({
                "sku": s,
                "week_start": monday.isoformat(),
                "actual_units": round(v30 * 7),
                "source": "velocity_v30",
            })

    if not rows:
        return {"rows_upserted": 0}

    inserted = upsert_rows("forecast_actuals_weekly", rows,
                           on_conflict="sku,week_start")
    return {"rows_upserted": inserted, "skus": len(set(r["sku"] for r in rows))}


# ── 2. Reconciliation ──

def reconcile(sku: str | None = None) -> dict:
    """Score completed forecast runs against actuals.

    For each run where end_date < today, sum actuals and compute
    MAPE / bias for each method.
    """
    client = get_client()

    # Get runs
    q = client.table("forecast_runs").select("*").lt("end_date", date.today().isoformat())
    if sku:
        q = q.eq("sku", sku)
    runs_resp = q.order("created_at", desc=True).limit(100).execute()
    runs = runs_resp.data or []

    # Get actuals
    actuals_resp = client.table("forecast_actuals_weekly").select("*").execute()
    actuals_by_sku: dict[str, dict[str, float]] = defaultdict(dict)
    for a in (actuals_resp.data or []):
        actuals_by_sku[a["sku"]][a["week_start"]] = float(a["actual_units"])

    scored = 0
    accuracy_rows: list[dict] = []

    # Group runs by SKU to compute aggregate accuracy
    sku_errors: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {"a": [], "b": [], "c": [], "primary": []}
    )

    for run in runs:
        s = run["sku"]
        actuals_map = actuals_by_sku.get(s, {})
        if not actuals_map:
            continue

        start = date.fromisoformat(run["start_date"])
        end = date.fromisoformat(run["end_date"])

        # Sum actuals over the run period
        total_actual = 0
        weeks_counted = 0
        cursor = start
        while cursor <= end:
            monday = cursor - timedelta(days=cursor.weekday())
            ws = monday.isoformat()
            if ws in actuals_map:
                total_actual += actuals_map[ws]
                weeks_counted += 1
            cursor += timedelta(weeks=1)

        if weeks_counted < 2:
            continue

        # Errors per method
        for method_key, run_key in [("a", "method_a_units"), ("b", "method_b_units"),
                                     ("c", "method_c_units"), ("primary", "expected_units")]:
            pred = float(run.get(run_key, 0) or 0)
            if pred > 0 and total_actual > 0:
                pct_error = abs(pred - total_actual) / total_actual
                sku_errors[s][method_key].append(pct_error)

        scored += 1

    # Build accuracy per SKU
    for s, errors in sku_errors.items():
        for window in [30, 90]:
            # Use all available errors (window is nominal)
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
            bias = 0  # simplified

            best = min(mape_by_method, key=lambda k: mape_by_method.get(k, 999)) if mape_by_method else "b"

            # Compute weights from inverse MAPE
            weights = _compute_weights(mape_by_method)

            accuracy_rows.append({
                "sku": s,
                "window_days": window,
                "mape": round(mape * 100, 1) if mape is not None else None,
                "bias": round(bias * 100, 1),
                "n_weeks": n,
                "best_method": best,
                "method_weights": json.dumps(weights),
            })

    if accuracy_rows:
        upsert_rows("forecast_accuracy", accuracy_rows,
                     on_conflict="sku,window_days")

    return {"runs_scored": scored, "skus_scored": len(sku_errors),
            "accuracy_rows": len(accuracy_rows)}


def _compute_weights(mape_by_method: dict[str, float]) -> dict[str, float]:
    """Inverse-MAPE weighting with floor and cap."""
    if not mape_by_method:
        return {"a": 0.15, "b": 0.60, "c": 0.25}

    # Inverse MAPE (lower error = higher weight)
    inv = {}
    for k, mape in mape_by_method.items():
        inv[k] = 1.0 / max(mape, 0.01)

    total = sum(inv.values())
    weights = {k: v / total for k, v in inv.items()}

    # Apply floor
    for k in weights:
        weights[k] = max(weights[k], WEIGHT_FLOOR)

    # Renormalize
    total = sum(weights.values())
    weights = {k: round(v / total, 3) for k, v in weights.items()}

    return weights


# ── 3. Calibration ──

def calibrate(sku: str | None = None) -> dict:
    """Update forecast_model_state with learned weights.

    Reads forecast_accuracy, computes blended weights, stores on
    model_state.  Respects MAX_WEIGHT_SHIFT to prevent wild swings.
    """
    client = get_client()

    # Get accuracy data
    q = client.table("forecast_accuracy").select("*")
    if sku:
        q = q.eq("sku", sku)
    acc_resp = q.execute()
    acc_rows = acc_resp.data or []

    if not acc_rows:
        return {"calibrated": 0, "message": "No accuracy data to calibrate from"}

    # Get current model state
    state_resp = client.table("forecast_model_state").select("*").execute()
    current_state: dict[str, dict] = {}
    for s in (state_resp.data or []):
        current_state[s["sku"]] = s

    # Global defaults
    defaults = current_state.get("*", {}).get("weights", {"a": 0.15, "b": 0.60, "c": 0.25})
    if isinstance(defaults, str):
        defaults = json.loads(defaults)

    calibrated = 0
    for row in acc_rows:
        s = row["sku"]
        n = row.get("n_weeks", 0) or 0
        if n < MIN_CALIBRATION_WEEKS:
            continue

        new_weights = row.get("method_weights")
        if isinstance(new_weights, str):
            new_weights = json.loads(new_weights)
        if not new_weights:
            continue

        # Get existing weights for this SKU (or global)
        existing = current_state.get(s, current_state.get("*", {}))
        old_weights = existing.get("weights", defaults)
        if isinstance(old_weights, str):
            old_weights = json.loads(old_weights)

        # Cap weight changes
        capped = {}
        for k in ["a", "b", "c"]:
            old = old_weights.get(k, 0.33)
            new = new_weights.get(k, old)
            delta = new - old
            capped_delta = max(-MAX_WEIGHT_SHIFT, min(MAX_WEIGHT_SHIFT, delta))
            capped[k] = round(max(WEIGHT_FLOOR, old + capped_delta), 3)

        # Renormalize
        total = sum(capped.values())
        capped = {k: round(v / total, 3) for k, v in capped.items()}

        version = f"cal-{date.today().isoformat()}"

        upsert_rows("forecast_model_state", [{
            "sku": s,
            "weights": json.dumps(capped),
            "model_version": version,
        }], on_conflict="sku")

        calibrated += 1
        log.info("Calibrated %s: weights=%s version=%s (from %d weeks)",
                 s, capped, version, n)

    return {"calibrated": calibrated}


# ── 4. Full reconcile pipeline ──

def run_full_reconcile(sku: str | None = None) -> dict:
    """Ingest actuals → reconcile → calibrate."""
    actuals = ingest_actuals(sku)
    recon = reconcile(sku)
    cal = calibrate(sku)
    return {
        "actuals": actuals,
        "reconciliation": recon,
        "calibration": cal,
    }
