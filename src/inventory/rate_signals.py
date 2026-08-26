"""Dual-rate calibration: orders report vs inventory total movement."""
from __future__ import annotations

import logging
from datetime import date, timedelta
from statistics import median

from src.db import fetch_all, upsert_rows
from src.inventory.inbound_shipments import median_receive_days
from src.inventory.snapshots_daily import fba_on_hand, inbound_total

log = logging.getLogger(__name__)

DIVERGENCE_WARN_PCT = 25


def _ledger_receipts(sku: str, start: date, end: date) -> int:
    """Positive receipt units from inventory ledger in [start, end]."""
    try:
        events = fetch_all("inventory_events")
    except Exception:
        return 0
    total = 0
    sku_u = sku.upper()
    for ev in events:
        if (ev.get("sku") or "").upper() != sku_u:
            continue
        ed = ev.get("event_date")
        if not ed or str(ed)[:10] < start.isoformat() or str(ed)[:10] > end.isoformat():
            continue
        et = (ev.get("event_type") or "").lower()
        qty = int(ev.get("quantity", 0) or 0)
        if qty > 0 and ("receipt" in et or et in {"receipts", "fc_transfer"}):
            total += qty
    return total


def _daily_for_sku(sku: str) -> list[dict]:
    try:
        rows = [
            r for r in fetch_all("inventory_snapshots_daily")
            if r.get("sku") == sku
        ]
    except Exception:
        return []
    rows.sort(key=lambda r: r.get("snapshot_date") or "")
    return rows


def implied_rate(sku: str, window: int, as_of: date | None = None) -> float | None:
    """Units/day from total_quantity change + ledger receipts over window."""
    end = as_of or date.today()
    start = end - timedelta(days=window)
    daily = _daily_for_sku(sku)
    if len(daily) < 2:
        return None

    in_window = [
        r for r in daily
        if start.isoformat() <= str(r.get("snapshot_date", ""))[:10] <= end.isoformat()
    ]
    if len(in_window) < 2:
        in_window = daily[-min(len(daily), window + 1):]
    if len(in_window) < 2:
        return None

    oldest, newest = in_window[0], in_window[-1]
    try:
        d0 = date.fromisoformat(str(oldest["snapshot_date"])[:10])
        d1 = date.fromisoformat(str(newest["snapshot_date"])[:10])
    except ValueError:
        return None
    span = max((d1 - d0).days, 1)

    q0 = int(oldest.get("total_quantity", 0) or 0)
    q1 = int(newest.get("total_quantity", 0) or 0)
    if q0 <= 0 and q1 <= 0:
        return None

    receipts = _ledger_receipts(sku, d0, d1)
    consumed = q0 - q1 + receipts
    if consumed < 0:
        return None
    return round(consumed / span, 2)


def _agreement(orders: float, inventory: float | None) -> tuple[str | None, float | None]:
    if inventory is None or orders <= 0:
        return None, None
    div = abs(inventory - orders) / orders * 100
    if div <= DIVERGENCE_WARN_PCT:
        return "ok", round(div, 1)
    return "investigate", round(div, 1)


def sync_sku_signals(configured_lead_days: int = 35) -> dict:
    """Recompute inventory_sku_signals for all SKUs with velocity + daily history."""
    try:
        velocities = fetch_all("sku_velocity")
    except Exception:
        velocities = []

    settings_lead = configured_lead_days
    try:
        settings = fetch_all("inventory_settings")
        if settings:
            settings_lead = int(settings[0].get("lead_time_days", configured_lead_days) or configured_lead_days)
    except Exception:
        pass

    account_recv, account_n = median_receive_days(limit=5)
    today = date.today()
    rows: list[dict] = []

    for vel in velocities:
        sku = vel.get("sku")
        if not sku:
            continue
        o7 = float(vel.get("amazon_u_7", 0) or 0)
        o30 = float(vel.get("amazon_u_30", 0) or 0)
        i7 = implied_rate(sku, 7, today)
        i30 = implied_rate(sku, 30, today)
        agreement, div = _agreement(o30, i30)
        recv, rn = median_receive_days(limit=5, sku=sku)
        if recv is None and account_recv is not None:
            recv, rn = account_recv, account_n

        rows.append({
            "sku": sku,
            "as_of_date": today.isoformat(),
            "orders_u_7": o7,
            "orders_u_30": o30,
            "inventory_u_7": i7,
            "inventory_u_30": i30,
            "rate_divergence_pct": div,
            "rate_agreement": agreement,
            "measured_receive_days": recv,
            "receive_sample_n": rn,
            "configured_lead_days": settings_lead,
        })

    n = 0
    if rows:
        n = upsert_rows("inventory_sku_signals", rows, on_conflict="sku")
    log.info("[RateSignals] %d SKUs calibrated", n)
    return {"skus": n, "account_receive_days": account_recv, "account_receive_n": account_n}


def build_snapshot_rows_from_current(snaps: list[dict]) -> list[dict]:
    """Fallback: seed daily row from live inventory_snapshots when API returns rows."""
    out = []
    for s in snaps:
        sku = s.get("sku")
        if not sku:
            continue
        fba = fba_on_hand(s)
        total = int(s.get("total_quantity", 0) or 0)
        if total <= 0:
            total = fba + inbound_total(s)
        out.append({
            "sku": sku,
            "total_quantity": total,
            "fulfillable": int(s.get("fulfillable", 0) or 0),
            "fba_on_hand": fba,
            "inbound_total": inbound_total(s),
            **{k: s.get(k) for k in (
                "reserved", "researching", "unfulfillable",
                "inbound_working", "inbound_shipped", "inbound_receiving",
            )},
        })
    return out
