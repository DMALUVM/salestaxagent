"""Filter SKUs to physical/inventory-only for forecast and planning.

is_inventory_sku(sku) returns True if the SKU appears in any recent
inventory source (snapshots, AWD, 3PL) or is in the config allowlist.
Digital / non-fulfillable products are excluded from demand forecasting,
calibration, and pallet planning — but NOT from tax pipeline.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from src.db import fetch_all

log = logging.getLogger(__name__)

_cache: set[str] | None = None


def _load_config_overrides() -> tuple[set[str], set[str]]:
    """Load optional allowlist/blocklist from config/inventory_skus.json."""
    allow: set[str] = set()
    block: set[str] = set()
    try:
        p = Path(__file__).resolve().parent.parent.parent / "config" / "inventory_skus.json"
        if p.exists():
            data = json.loads(p.read_text())
            allow = set(data.get("allow", []))
            block = set(data.get("block", []))
    except Exception:
        pass
    return allow, block


def get_inventory_skus(force_refresh: bool = False) -> set[str]:
    """Return the set of SKUs that are physical / inventory-bearing.

    Sources:
      1. config/inventory_skus.json allowlist (always included)
      2. inventory_snapshots (FBA)
      3. inventory_awd
      4. inventory_3pl_snapshots
    Minus any config blocklist entries.
    """
    global _cache
    if _cache is not None and not force_refresh:
        return _cache

    allow, block = _load_config_overrides()
    skus = set(allow)

    for table in ("inventory_snapshots", "inventory_awd", "inventory_3pl_snapshots"):
        try:
            for r in fetch_all(table):
                s = r.get("sku")
                if s:
                    skus.add(s)
        except Exception:
            pass

    skus -= block
    _cache = skus
    return skus


def is_inventory_sku(sku: str) -> bool:
    """True if SKU is physical / inventory-bearing."""
    return sku in get_inventory_skus()


def filter_inventory_skus(skus: list[str] | set[str]) -> tuple[list[str], list[str]]:
    """Split SKUs into (physical, skipped) lists."""
    inv = get_inventory_skus()
    physical = [s for s in skus if s in inv]
    skipped = [s for s in skus if s not in inv]
    return physical, skipped
