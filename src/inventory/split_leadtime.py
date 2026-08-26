"""First-box vs last-box receive on multi-FC AWD→FBA splits.

Dave sends every replenishment as an optimized split (often 4–5 FCs).
The old 'FBA optimized' card looked for closed Send-to-Amazon inbound
rows grouped by ship day — this account has none, so the card stayed blank.

AWD replenishment `raw.outboundShipments` already has per-box DELIVERED
timestamps. First box is when sellable stock starts landing; last box is
when the whole wave is in.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

MIN_FCS = 2
MIN_DAYS = 1
MAX_DAYS = 45


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _day_span(start: Any, end: Any) -> int | None:
    a = _parse_dt(start)
    b = _parse_dt(end)
    if a is None or b is None or b < a:
        return None
    return int(round((b - a).total_seconds() / 86_400))


def _median_int(vals: list[int]) -> int | None:
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    if n % 2:
        return s[n // 2]
    # Half-up so 2.5 → 3, matching JS Math.round.
    return (s[n // 2 - 1] + s[n // 2] + 1) // 2


def _outbound_list(order: dict) -> list[dict]:
    raw = order.get("raw")
    if isinstance(raw, dict) and raw.get("outboundShipments"):
        return [ob for ob in raw["outboundShipments"] if isinstance(ob, dict)]
    return []


def split_leg_days(order: dict) -> list[int]:
    """Days from ship/create to each DELIVERED outbound box."""
    outbound = _outbound_list(order)
    start = _parse_dt(order.get("shipped_at")) or _parse_dt(order.get("created_at"))
    days: list[int] = []
    for ob in outbound:
        if (ob.get("shipmentStatus") or "").upper() != "DELIVERED":
            continue
        if start is None:
            start = _parse_dt(ob.get("createdAt"))
        span = _day_span(start, ob.get("updatedAt"))
        if span is not None and MIN_DAYS <= span <= MAX_DAYS:
            days.append(span)
    return days


def first_last_from_replenishments(orders: list[dict]) -> dict:
    firsts: list[int] = []
    lasts: list[int] = []
    spreads: list[int] = []
    for order in orders:
        if (order.get("order_status") or "").upper() != "SUCCESS":
            continue
        days = split_leg_days(order)
        if len(days) < MIN_FCS:
            continue
        firsts.append(min(days))
        lasts.append(max(days))
        spreads.append(max(days) - min(days))
    return {
        "first_box_days": _median_int(firsts),
        "last_box_days": _median_int(lasts),
        "box_spread_days": _median_int(spreads),
        "split_n": len(firsts),
    }


def open_inbound_split(ships: list[dict], today: date | None = None) -> dict | None:
    """Newest in-transit same-day multi-FC inbound (the 5-box send)."""
    today = today or date.today()
    by_day: dict[str, list[dict]] = {}
    for s in ships:
        status = (s.get("shipment_status") or "").upper()
        if status in {"CLOSED", "CANCELLED", "DELETED"}:
            continue
        day = str(s.get("shipped_at") or s.get("created_at") or "")[:10]
        if not day:
            continue
        by_day.setdefault(day, []).append(s)

    open_days = sorted(by_day, reverse=True)
    for day in open_days:
        group = by_day[day]
        fcs = sorted({
            str(s.get("destination_fc"))
            for s in group
            if s.get("destination_fc")
        })
        if len(fcs) < MIN_FCS:
            continue
        try:
            age = (today - date.fromisoformat(day)).days
        except ValueError:
            age = None
        return {
            "shipped_on": day,
            "boxes": len(group),
            "fcs": fcs,
            "age_days": age,
        }
    return None
