"""Monotonic write guard for daily sales totals.

The Pulse chart reads `sales_daily`. Every writer there does an unconditional
upsert of whatever it managed to accumulate, so any run that saw an incomplete
picture of a day — a truncated report download, a chunk that failed and was
skipped with `continue`, a window whose UTC bounds only partly cover an LA day —
silently replaced a complete day with a smaller one. Nothing compared the new
value against what was already stored, and the table carried no provenance, so
the damage was invisible and the same days kept regressing after being fixed.

The rule here is simple and is what makes the regression structurally
impossible rather than merely fixed: **a closed day's totals may grow, but may
not shrink.** Sales for a past day are cumulative — late-arriving orders and
status changes push them up. A smaller number for a closed day is far more
likely to mean "this run saw less" than "sales were retroactively removed".

Shrinkage is not silently ignored. It is refused, recorded, and surfaced, so a
genuine decrease (a real refund sweep, a corrected duplicate) can be applied
deliberately with `allow_decrease=True` rather than by accident at 3am.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

log = logging.getLogger(__name__)

# A day's total may drift down by rounding or a single cancelled order without
# meaning the run was incomplete. Below this the write is allowed through.
TOLERANCE_PCT = 2.0
TOLERANCE_ABS = 5.00


@dataclass
class GuardResult:
    to_write: list[dict] = field(default_factory=list)
    blocked: list[dict] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def blocked_days(self) -> list[str]:
        return sorted({str(r.get("sale_date")) for r in self.blocked})


def _key(row: dict) -> tuple:
    return (str(row.get("sale_date")), str(row.get("channel")))


def is_shrink(new_gross: float, old_gross: float,
              new_orders: int, old_orders: int) -> bool:
    """Would this write materially reduce a stored day?

    Order count is checked as well as money: a partial pull loses whole orders,
    which is the signal that separates "saw less data" from "a refund landed".
    """
    if old_gross <= 0 and old_orders <= 0:
        return False
    drop = old_gross - new_gross
    if drop > TOLERANCE_ABS and (drop / old_gross * 100.0) > TOLERANCE_PCT:
        return True
    # Losing orders outright is a partial-pull signature even if money is close.
    if old_orders > 0 and new_orders < old_orders * (1 - TOLERANCE_PCT / 100.0):
        return True
    return False


def guard_rows(new_rows: list[dict], existing_rows: list[dict],
               today: date, allow_decrease: bool = False,
               job: str = "unknown") -> GuardResult:
    """Split candidate rows into safe writes and refused shrinks.

    `today` is passed in rather than read from the clock so this stays pure and
    testable. The current day is always written: it is legitimately partial and
    is flagged incomplete rather than guarded, because guarding it would freeze
    the first value seen each morning.
    """
    res = GuardResult()
    old = {_key(r): r for r in existing_rows}
    today_iso = today.isoformat()

    for row in new_rows:
        k = _key(row)
        prev = old.get(k)
        day = str(row.get("sale_date"))
        new_gross = float(row.get("gross_sales") or 0)
        new_orders = int(row.get("order_count") or 0)

        # The in-progress day is expected to be partial all day long.
        if day >= today_iso:
            res.to_write.append({**row, "is_complete": False})
            continue

        if prev is None:
            res.to_write.append({**row, "is_complete": True})
            continue

        old_gross = float(prev.get("gross_sales") or 0)
        old_orders = int(prev.get("order_count") or 0)

        if not is_shrink(new_gross, old_gross, new_orders, old_orders):
            res.to_write.append({**row, "is_complete": True})
            continue

        if allow_decrease:
            res.reasons.append(
                f"{day} {row.get('channel')}: applied an explicit decrease "
                f"${old_gross:,.2f}->${new_gross:,.2f} "
                f"({old_orders}->{new_orders} orders) [allow_decrease]")
            res.to_write.append({**row, "is_complete": True})
            continue

        reason = (
            f"{day} {row.get('channel')}: REFUSED write that would drop "
            f"${old_gross:,.2f}->${new_gross:,.2f} "
            f"({old_orders}->{new_orders} orders). This run saw less data than "
            f"is already stored — almost always an incomplete pull. Re-run with "
            f"a wider window, or pass allow_decrease=True if the drop is real.")
        res.reasons.append(reason)
        res.blocked.append(row)
        log.warning("sales guard [%s] %s", job, reason)

    return res
