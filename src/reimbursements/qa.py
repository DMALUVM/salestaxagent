"""Needs-case classification / sync QA and the Reese notify gate."""
from __future__ import annotations

from typing import Iterable

from src.reimbursements.reason_legend import (
    CLASSIFICATION_VERSION,
    MINI_RESYNC_HINT,
    NOTIFY_BLOCK_COPY,
    UNKNOWN_REASON_MAX_PCT,
    is_unknown_reason,
)

STATUS_NEEDS_CASE = "needs_case"


class CaseQueueSyncError(RuntimeError):
    """Loud sync failure — do not treat the queue as verified."""

    def __init__(self, message: str, qa: dict | None = None):
        super().__init__(message)
        self.qa = qa or {"ok": False, "errors": [message]}


def _needs(events: Iterable[dict]) -> list[dict]:
    return [
        e for e in events
        if e.get("status") == STATUS_NEEDS_CASE and int(e.get("quantity") or 0) > 0
    ]


def unknown_reason_pct(rows: Iterable[dict]) -> float:
    items = list(rows)
    if not items:
        return 0.0
    unknown = sum(
        1 for r in items
        if is_unknown_reason(r.get("reason"), r.get("disposition"))
    )
    return round(100.0 * unknown / len(items), 2)


def evaluate_queue_qa(
    events: Iterable[dict],
    *,
    negative_adjustments: Iterable[dict] | None = None,
    adjustments_empty_after_prior: bool = False,
    classification_version: str = CLASSIFICATION_VERSION,
) -> dict:
    """Sync + classification health. ok=False means do not prep Reese packets."""
    errors: list[str] = []
    if adjustments_empty_after_prior:
        errors.append(
            "Adjustments pull returned empty when previous sync had rows. "
            "Supabase/SP-API flake — do not rebuild from an empty ledger. "
            + MINI_RESYNC_HINT
        )

    needs = _needs(events)
    adj = list(negative_adjustments) if negative_adjustments is not None else needs
    pct = unknown_reason_pct(adj)
    if pct > UNKNOWN_REASON_MAX_PCT:
        errors.append(
            f"{pct}% of eligible/negative ledger rows have unknown reason codes "
            f"(max {UNKNOWN_REASON_MAX_PCT}%). {MINI_RESYNC_HINT}"
        )

    outdated = 0
    missing_fc = 0
    unknown_needs = 0
    for ev in needs:
        if is_unknown_reason(ev.get("reason"), ev.get("disposition")):
            unknown_needs += 1
        if not (ev.get("fulfillment_center") or "").strip():
            missing_fc += 1
        ver = ev.get("classification_version")
        if ver != classification_version:
            outdated += 1
    if unknown_needs:
        errors.append(
            f"{unknown_needs} Needs-case row(s) have an unknown reason code."
        )
    if missing_fc:
        errors.append(
            f"{missing_fc} Needs-case row(s) are missing fulfillment_center (FC)."
        )
    if outdated and needs:
        errors.append(
            f"{outdated} Needs-case row(s) have missing or outdated "
            f"classification_version (want {classification_version}). "
            + MINI_RESYNC_HINT
        )

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "classification_version": classification_version,
        "unknown_reason_pct": pct,
        "needs_case": len(needs),
        "outdated_classification": outdated,
        "missing_fc": missing_fc,
    }


def notify_gate_errors(
    events: Iterable[dict],
    qa: dict | None = None,
    *,
    classification_version: str = CLASSIFICATION_VERSION,
) -> list[str]:
    """Reasons to refuse Reese notify. Empty list = allowed."""
    errors: list[str] = []
    if qa and not qa.get("ok"):
        errors.extend(str(e) for e in (qa.get("errors") or []) if e)
    for ev in _needs(events):
        key = ev.get("event_key") or "?"
        if is_unknown_reason(ev.get("reason"), ev.get("disposition")):
            errors.append(f"{key}: unknown reason code {ev.get('reason')!r}")
        if not (ev.get("fulfillment_center") or "").strip():
            errors.append(f"{key}: missing FC")
        if ev.get("classification_version") != classification_version:
            errors.append(
                f"{key}: classification_version outdated "
                f"({ev.get('classification_version')!r} != {classification_version!r})"
            )
    # Dedup while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for err in errors:
        if err in seen:
            continue
        seen.add(err)
        out.append(err)
    return out


def notify_blocked_payload(errors: list[str], qa: dict | None = None) -> dict:
    return {
        "ok": False,
        "error": NOTIFY_BLOCK_COPY,
        "qa": qa or {"ok": False, "errors": errors},
        "errors": errors,
        "auto_submit": False,
        "hint": MINI_RESYNC_HINT,
    }
