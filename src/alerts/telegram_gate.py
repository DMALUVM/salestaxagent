"""Telegram allow/deny gate — important updates ONLY.

Every scheduled Telegram path passes a topic. Deny wins over allow.
Silent when the topic is not on the allowlist. Config lives in
``config/business_rules.json`` → ``src.rules``; do not duplicate the lists.
"""
from __future__ import annotations

from src.rules import TELEGRAM_ALLOW, TELEGRAM_DENY, TELEGRAM_IMPORTANT_ONLY


def telegram_allowed(topic: str | None) -> bool:
    """True when this topic may be delivered.

    Deny always wins. When ``important_updates_only`` is on (the locked
    default), unknown / missing topics are refused so a new sender cannot
    quietly start paging again.
    """
    if not topic:
        return not TELEGRAM_IMPORTANT_ONLY
    if topic in TELEGRAM_DENY:
        return False
    if not TELEGRAM_IMPORTANT_ONLY:
        return True
    return topic in TELEGRAM_ALLOW


def telegram_decision(topic: str | None) -> tuple[bool, str]:
    """Return (allowed, reason) for tests and caller logs."""
    if not topic:
        if TELEGRAM_IMPORTANT_ONLY:
            return False, "missing topic — refuse under important_updates_only"
        return True, "no topic; important_updates_only is off"
    if topic in TELEGRAM_DENY:
        return False, f"denied:{topic}"
    if topic in TELEGRAM_ALLOW:
        return True, f"allowed:{topic}"
    if TELEGRAM_IMPORTANT_ONLY:
        return False, f"not on allowlist:{topic}"
    return True, f"unlisted:{topic} (important_updates_only is off)"
