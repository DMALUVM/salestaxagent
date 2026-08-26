"""Inbound shipment timing: shipped → received / Prime-eligible."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

SHIPPED_STATUSES = frozenset({
    "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKING_IN", "CHECKED_IN",
    "RECEIVING", "CLOSED",
})
RECEIVING_STATUSES = frozenset({"RECEIVING", "CLOSED", "CHECKED_IN", "DELIVERED"})
CLOSED_STATUSES = frozenset({"CLOSED"})


def day_span(start: datetime | None, end: datetime | None) -> int | None:
    if not start or not end:
        return None
    return max((end.date() - start.date()).days, 0)


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _parse_gmt_date(value: str) -> datetime | None:
    """Parse 'Wed Feb 15 00:00:00 GMT 2023' from transport API."""
    m = re.match(
        r"\w{3}\s+(\w{3})\s+(\d{1,2})\s+\d{2}:\d{2}:\d{2}\s+GMT\s+(\d{4})",
        value.strip(),
    )
    if not m:
        return None
    mon, day, year = m.group(1), int(m.group(2)), int(m.group(3))
    months = {
        "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
        "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
    }
    mo = months.get(mon)
    if not mo:
        return None
    return datetime(year, mo, day, tzinfo=timezone.utc)


def transport_shipped_date(payload: dict | None) -> datetime | None:
    """Best pickup/ship date from getTransportDetails payload."""
    if not payload:
        return None
    content = payload.get("TransportContent") or payload.get("transportContent") or payload
    details = content.get("TransportDetails") or content.get("transportDetails") or {}

    candidates: list[datetime] = []
    for key in ("PartneredLtlData", "partneredLtlData"):
        ltl = details.get(key) or {}
        for field in ("PreviewPickupDate", "previewPickupDate", "FreightReadyDate", "freightReadyDate"):
            raw = ltl.get(field)
            if isinstance(raw, str):
                dt = _parse_gmt_date(raw) or parse_ts(raw)
                if dt:
                    candidates.append(dt)

    for key in ("PartneredSmallParcelData", "partneredSmallParcelData"):
        sp = details.get(key) or {}
        for pkg in sp.get("PackageList") or sp.get("packageList") or []:
            status = (pkg.get("PackageStatus") or pkg.get("packageStatus") or "").upper()
            if status == "SHIPPED":
                # No per-package date in API — use estimate confirm as weak signal only if present
                pass

    if not candidates:
        return None
    return min(candidates)


def ledger_receipt_dates(
    skus: list[str],
    fc: str | None,
    start: date | None,
    end: date | None,
) -> tuple[datetime | None, datetime | None]:
    """First receipt and first sellable receipt at FC for SKUs in [start, end]."""
    if not skus or not fc:
        return None, None
    try:
        from src.db import fetch_all
        events = fetch_all("inventory_events")
    except Exception:
        return None, None

    sku_set = {s.upper() for s in skus if s}
    fc_u = fc.upper()
    first_recv: datetime | None = None
    first_sellable: datetime | None = None

    for ev in events:
        if (ev.get("fc_code") or "").upper() != fc_u:
            continue
        if (ev.get("sku") or "").upper() not in sku_set:
            continue
        ed = ev.get("event_date")
        if not ed:
            continue
        try:
            edate = date.fromisoformat(str(ed)[:10])
        except ValueError:
            continue
        if start and edate < start:
            continue
        if end and edate > end:
            continue
        et = (ev.get("event_type") or "").lower()
        if int(ev.get("quantity", 0) or 0) <= 0:
            continue
        if "receipt" not in et:
            continue
        ts = datetime.combine(edate, datetime.min.time(), tzinfo=timezone.utc)
        if first_recv is None or ts < first_recv:
            first_recv = ts
        disp = (ev.get("disposition") or "").lower()
        if "sellable" in disp or disp in {"", "sellable"}:
            if first_sellable is None or ts < first_sellable:
                first_sellable = ts

    return first_recv, first_sellable


def update_shipped_at(
    prev: dict | None,
    status: str,
    updated: datetime | None,
    created: datetime | None,
    transport_dt: datetime | None,
) -> datetime | None:
    prev_status = ((prev or {}).get("shipment_status") or "").upper()
    existing = parse_ts((prev or {}).get("shipped_at"))
    if existing:
        return existing

    if transport_dt:
        return transport_dt

    st = status.upper()
    if st == "SHIPPED" and prev_status in {"", "WORKING", "READY_TO_SHIP"} and updated:
        return updated
    if st in SHIPPED_STATUSES and prev_status in {"", "WORKING", "READY_TO_SHIP"} and updated:
        # Jumped straight to RECEIVING/CLOSED without catching SHIPPED poll
        return updated
    if st in SHIPPED_STATUSES and created and not prev:
        # Historical closed shipment — created is weak fallback until transport/ledger fills in
        return None
    return None


def update_received_at(
    prev: dict | None,
    status: str,
    updated: datetime | None,
    closed_at: datetime | None,
    units_received: int,
) -> datetime | None:
    existing = parse_ts((prev or {}).get("received_at"))
    if existing:
        return existing

    prev_status = ((prev or {}).get("shipment_status") or "").upper()
    st = status.upper()

    if st == "RECEIVING" and prev_status not in RECEIVING_STATUSES and updated:
        return updated
    if st in CLOSED_STATUSES and (closed_at or updated):
        return closed_at or updated
    if units_received > 0 and updated and st in RECEIVING_STATUSES:
        return updated
    return None


def compute_receive_days(
    shipped_at: datetime | None,
    received_at: datetime | None,
    prime_eligible_at: datetime | None,
    closed_at: datetime | None,
    created_at: datetime | None,
) -> tuple[int | None, str]:
    """Return (days, basis). Prefer shipped→Prime, then shipped→received."""
    if shipped_at and prime_eligible_at:
        d = day_span(shipped_at, prime_eligible_at)
        if d is not None:
            return d, "shipped_to_prime"
    if shipped_at and received_at:
        d = day_span(shipped_at, received_at)
        if d is not None:
            return d, "shipped_to_received"
    if shipped_at and closed_at:
        d = day_span(shipped_at, closed_at)
        if d is not None:
            return d, "shipped_to_closed"
    if created_at and closed_at:
        d = day_span(created_at, closed_at)
        if d is not None:
            return d, "created_to_closed_fallback"
    return None, "unknown"
