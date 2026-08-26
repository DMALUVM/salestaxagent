"""Inventory lines for the morning Telegram digest — solo-operator daily checklist."""
from __future__ import annotations

from src.inventory.report import build_report


def build_inventory_digest_lines() -> list[str]:
    """Return HTML lines for inventory logistics (empty if no data)."""
    try:
        report = build_report()
    except Exception:
        return []

    summary = report.get("summary") or {}
    rows = report.get("rows") or []
    if not rows:
        return []

    critical = [r for r in rows if r.get("flag") == "CRITICAL"]
    restock = [r for r in rows if int(r.get("our_reorder_qty", 0) or 0) > 0]
    total_reorder = int(summary.get("total_our_reorder", 0) or 0)
    at_risk = int(summary.get("at_risk_skus", 0) or 0)

    lines: list[str] = ["", "<b>Inventory logistics</b>"]
    lines.append(
        f"{at_risk} SKUs &lt;60d FBA · {len(critical)} CRITICAL · "
        f"reorder {total_reorder:,} u"
    )

    if critical:
        top = sorted(critical, key=lambda r: float(r.get("dos", 9999)))[:3]
        for r in top:
            dos = r.get("dos", "?")
            sku = r.get("sku", "?")
            oos = r.get("stockout_date") or "—"
            lines.append(f"  🔴 {sku}: {dos}d FBA · OOS {oos}")

    elif restock:
        top = sorted(restock, key=lambda r: -int(r.get("our_reorder_qty", 0) or 0))[:3]
        for r in top:
            qty = int(r.get("our_reorder_qty", 0) or 0)
            sku = r.get("sku", "?")
            lines.append(f"  📦 {sku}: reorder {qty:,} u")

    else:
        lines.append("  ✅ FBA cover OK — no urgent reorders")

    return lines
