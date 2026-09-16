"""Inventory lines for the important-only Telegram ping.

Pure: snapshots + inbound rows → compact lines. No DB, no network.
Damaged / unfillable and freshly checked-in are the only inventory
topics Dave wants on Telegram. Standing restock chatter stays off.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

# Amazon inbound statuses that mean units have reached an FC.
CHECKED_IN_STATUSES = frozenset({
    "CHECKED_IN", "CHECKING_IN", "RECEIVING", "CLOSED", "DELIVERED",
})


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _parse_day(value) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
        except ValueError:
            return None


def damaged_unfillable_lines(snapshots: list[dict], min_qty: int = 1) -> list[str]:
    """SKUs with unfulfillable / damaged units sitting at FBA."""
    rows = []
    for snap in snapshots:
        qty = _as_int(snap.get("unfulfillable"))
        if qty >= min_qty:
            rows.append((qty, str(snap.get("sku") or "?")))
    if not rows:
        return []
    rows.sort(key=lambda r: -r[0])
    total = sum(q for q, _ in rows)
    lines = [
        f"⚠️ Inventory damaged/unfillable: {total} u across {len(rows)} SKU(s)",
    ]
    for qty, sku in rows[:5]:
        lines.append(f"  {sku}: {qty} u")
    if len(rows) > 5:
        lines.append(f"  +{len(rows) - 5} more")
    return lines


def checked_in_lines(
    shipments: list[dict],
    today: date | None = None,
    lookback_days: int = 2,
) -> list[str]:
    """Inbound shipments that newly checked in / received units recently.

    Standing CLOSED history is not a ping — only a receive in the lookback
    window. ``lookback_days=2`` covers an overnight Pacific/Eastern split.
    """
    day = today or datetime.now(timezone.utc).date()
    since = day - timedelta(days=lookback_days)
    hits: list[tuple[int, str, str]] = []
    for ship in shipments:
        status = str(ship.get("shipment_status") or "").upper()
        received = _as_int(ship.get("units_received"))
        recv_day = _parse_day(ship.get("received_at"))
        if received <= 0:
            continue
        if recv_day is None and status not in CHECKED_IN_STATUSES:
            continue
        if recv_day is not None and recv_day < since:
            continue
        if recv_day is None:
            # Status says checked-in but no receive stamp — skip old CLOSED
            # rows that never recorded received_at.
            if status not in {"CHECKED_IN", "CHECKING_IN", "RECEIVING"}:
                continue
        sid = str(ship.get("shipment_id") or "?")
        hits.append((received, sid, status or "RECEIVED"))
    if not hits:
        return []
    hits.sort(key=lambda r: -r[0])
    total = sum(q for q, _, _ in hits)
    lines = [
        f"📦 Inventory checked in: {total} u across {len(hits)} shipment(s)",
    ]
    for qty, sid, status in hits[:5]:
        lines.append(f"  {sid}: {qty} u ({status})")
    if len(hits) > 5:
        lines.append(f"  +{len(hits) - 5} more")
    return lines


def build_inventory_alert_lines(
    snapshots: list[dict] | None = None,
    shipments: list[dict] | None = None,
    today: date | None = None,
) -> list[str]:
    """Combine damaged/unfillable + checked-in. Empty when neither matters."""
    lines: list[str] = []
    damaged = damaged_unfillable_lines(snapshots or [])
    checked = checked_in_lines(shipments or [], today=today)
    if damaged:
        lines.append("")
        lines.extend(damaged)
    if checked:
        lines.append("")
        lines.extend(checked)
    return lines
