"""Amazon FBA inventory-ledger adjustment reason legend.

Authoritative mapping from Seller Central / SP-API Adjustment reason codes.
Letter **M is Inventory misplaced → lost_warehouse**. It is never Lost inbound.

Needs-case eligibility is only misplaced (M / Lost_Warehouse) and warehouse
damage (E/6/7/H/K/U / Damaged_*), plus real inbound shorts (Lost_Inbound
full text / inbound_discrepancy). Q/P disposition churn, G disposed, and
N ownership/correction are excluded. Code **7 is Damaged at FC, not Found**.

After a deploy, Mini must rebuild:

    python -m src.main reimbursements-case-sync --days 90
"""
from __future__ import annotations

from dataclasses import dataclass

CLASSIFICATION_VERSION = "ledger-legend-2026-09-15"

ELIGIBLE_REASON_GROUPS = frozenset({
    "warehouse_damage",
    "lost_inbound",
    "lost_warehouse",
})

UNKNOWN_REASON_MAX_PCT = 5.0

WAREHOUSE_DAMAGE_DISPOSITIONS = frozenset({
    "WAREHOUSE_DAMAGED",
    "CUSTOMER_DAMAGED",
    "CARRIER_DAMAGED",
    "DEFECTIVE",
    "DAMAGED",
})

NOTIFY_BLOCK_COPY = (
    "Do not prep. Classification or QA checks failed — "
    "Needs-case packets are not verified. Do not send Reese a package."
)

MINI_RESYNC_HINT = (
    "Mini must re-run: python -m src.main reimbursements-case-sync --days 90 "
    "to rebuild fba_case_events with classification_version "
    f"{CLASSIFICATION_VERSION}."
)


@dataclass(frozen=True)
class ReasonLegendRow:
    """One Amazon ledger / reimbursements reason."""

    code: str
    sign: str
    label: str
    group: str
    eligible: bool
    notes: str


# Seller Central / SP-API Adjustment reason codes (authoritative table).
LEDGER_REASON_LEGEND: tuple[ReasonLegendRow, ...] = (
    ReasonLegendRow(
        "M", "-", "Inventory misplaced", "lost_warehouse", True,
        "Missing from a bin in an FC. NOT lost inbound. Eligible if unreconciled / not offset by Found.",
    ),
    ReasonLegendRow(
        "F", "+", "Inventory found", "found", False,
        "Offset for M / Lost_Warehouse. Never a Needs-case row.",
    ),
    ReasonLegendRow(
        "Q", "-", "Disposition change", "disposition_change", False,
        "Q/P pair is disposition churn — not a reimbursement case.",
    ),
    ReasonLegendRow(
        "P", "+", "Disposition change", "disposition_change", False,
        "Q/P pair is disposition churn — not a reimbursement case.",
    ),
    ReasonLegendRow(
        "E", "-", "Damaged at FC", "warehouse_damage", True,
        "Sellable decrease at fulfillment center. Typically followed by P.",
    ),
    ReasonLegendRow(
        "6", "-", "Damaged at FC", "warehouse_damage", True,
        "Reclass into FC-damaged.",
    ),
    ReasonLegendRow(
        "7", "-", "Damaged at FC", "warehouse_damage", True,
        "Damaged at FC variant. Code 7 is NOT Found.",
    ),
    ReasonLegendRow(
        "H", "-", "Damaged at FC", "warehouse_damage", True,
        "Reclass into FC-damaged.",
    ),
    ReasonLegendRow(
        "K", "-", "Damaged at FC", "warehouse_damage", True,
        "Reclass into FC-damaged.",
    ),
    ReasonLegendRow(
        "U", "-", "Damaged at FC", "warehouse_damage", True,
        "Reclass into FC-damaged.",
    ),
    ReasonLegendRow(
        "G", "-", "Disposed", "disposed", False,
        "Charity / disposal. Exclude from Needs case.",
    ),
    ReasonLegendRow(
        "N", "+", "Ownership / correction", "correction", False,
        "Not a loss case.",
    ),
)

# Full-text reimbursements / ledger reasons (keep today's groups).
FULL_TEXT_REASONS: tuple[ReasonLegendRow, ...] = (
    ReasonLegendRow(
        "Lost_Warehouse", "", "Lost warehouse", "lost_warehouse", True,
        "Full-text ledger / paid-desk reason.",
    ),
    ReasonLegendRow(
        "Lost_Inbound", "", "Lost inbound", "lost_inbound", True,
        "Full-text inbound loss only — never inferred from letter M.",
    ),
    ReasonLegendRow(
        "Damaged_Warehouse", "", "Warehouse damage", "warehouse_damage", True,
        "Full-text ledger / paid-desk reason.",
    ),
    ReasonLegendRow(
        "Damaged_Inbound", "", "Warehouse damage", "warehouse_damage", True,
        "Inbound damage treated as warehouse_damage.",
    ),
    ReasonLegendRow(
        "Found", "+", "Inventory found", "found", False,
        "Offset for misplaced / lost warehouse.",
    ),
    ReasonLegendRow(
        "Found_Warehouse", "+", "Inventory found", "found", False,
        "Offset for misplaced / lost warehouse.",
    ),
)


def _reason_key(reason: str | None) -> str:
    return (reason or "").strip().lower().replace(" ", "_").replace("-", "_")


def _index() -> dict[str, ReasonLegendRow]:
    out: dict[str, ReasonLegendRow] = {}
    for row in LEDGER_REASON_LEGEND + FULL_TEXT_REASONS:
        out[_reason_key(row.code)] = row
        compact = _reason_key(row.code).replace("_", "")
        out.setdefault(compact, row)
    # Aliases used by the paid desk / older rows.
    out["warehouse_damage"] = next(r for r in FULL_TEXT_REASONS if r.code == "Damaged_Warehouse")
    out["warehousedamage"] = out["warehouse_damage"]
    out["inbound_lost"] = next(r for r in FULL_TEXT_REASONS if r.code == "Lost_Inbound")
    out["warehouse_lost"] = next(r for r in FULL_TEXT_REASONS if r.code == "Lost_Warehouse")
    out["foundwarehouse"] = next(r for r in FULL_TEXT_REASONS if r.code == "Found_Warehouse")
    return out


_LEGEND_INDEX = _index()


def lookup_reason(reason: str | None) -> ReasonLegendRow | None:
    key = _reason_key(reason)
    if not key:
        return None
    return _LEGEND_INDEX.get(key)


def is_letter_or_digit_code(reason: str | None) -> bool:
    raw = (reason or "").strip()
    return len(raw) == 1 and raw.isalnum()


def reason_group(reason: str | None, disposition: str | None = None) -> str:
    """Map Amazon ledger / reimbursements reason → desk group.

    M → lost_warehouse (never lost_inbound). Disposition is a secondary
    warehouse-damage signal only when the reason itself is unknown.
    """
    entry = lookup_reason(reason)
    if entry:
        if entry.group in ELIGIBLE_REASON_GROUPS:
            return entry.group
        return "other"
    disp = (disposition or "").strip().upper().replace(" ", "_").replace("-", "_")
    if disp in WAREHOUSE_DAMAGE_DISPOSITIONS:
        return "warehouse_damage"
    return "other"


def reason_label(reason: str | None, disposition: str | None = None) -> str:
    """Human label. Letter codes render as ``M — Inventory misplaced``."""
    raw = (reason or "").strip()
    entry = lookup_reason(raw)
    if entry:
        if is_letter_or_digit_code(raw):
            return f"{raw.upper()} — {entry.label}"
        return entry.label
    if not raw:
        disp = (disposition or "").strip()
        if disp and reason_group(None, disp) == "warehouse_damage":
            return f"{disp} — Warehouse damage"
        return "Unknown"
    return raw.replace("_", " ").replace("-", " ")


def is_found_reason(reason: str | None) -> bool:
    """True for F / Found*. Code 7 is damaged, not found."""
    entry = lookup_reason(reason)
    if entry:
        return entry.group == "found"
    key = _reason_key(reason)
    return bool(key) and key.startswith("found")


def is_eligible_loss(
    reason: str | None,
    quantity: int,
    disposition: str | None = None,
    unreconciled_qty: int | None = None,
) -> bool:
    """Negative qty of an eligible loss type, not Q/P/G/N/F."""
    if quantity >= 0:
        return False
    entry = lookup_reason(reason)
    if entry and not entry.eligible:
        return False
    group = reason_group(reason, disposition)
    if group not in ELIGIBLE_REASON_GROUPS:
        return False
    if group == "lost_warehouse" and unreconciled_qty is not None:
        try:
            if int(unreconciled_qty) == 0:
                return False
        except (TypeError, ValueError):
            pass
    return True


def is_unknown_reason(reason: str | None, disposition: str | None = None) -> bool:
    """True when the code is not in the legend and disposition does not classify it."""
    if lookup_reason(reason):
        return False
    if reason_group(reason, disposition) != "other":
        return False
    return True


def is_known_excluded(reason: str | None) -> bool:
    entry = lookup_reason(reason)
    return bool(entry) and not entry.eligible
