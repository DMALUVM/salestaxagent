"""SKU normalization — single source of truth.

Every code path that reads or writes a SKU must call ``normalize_sku()``
so that "ddpe12345" and "DDPE12345" merge into one canonical key.

Rules:
  - Strip whitespace
  - Uppercase (casefold then upper for Unicode safety)
  - Empty / whitespace-only → "UNKNOWN"
"""
from __future__ import annotations


def normalize_sku(raw: str | None) -> str:
    """Return a canonical uppercase SKU, or "UNKNOWN" if empty."""
    if not raw:
        return "UNKNOWN"
    cleaned = raw.strip().upper()
    return cleaned if cleaned else "UNKNOWN"
