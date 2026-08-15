"""Canonical channel and source identifiers for sales data.

Every place that checks whether a record is "shopify" vs "amazon" should
use these helpers instead of raw string comparisons.
"""
from __future__ import annotations

# Canonical channel names (must match the CHECK constraint on sales_by_state)
SHOPIFY = "shopify"
AMAZON = "amazon"
OTHER = "other"

# Maps any known source / file_type / channel string to its canonical channel
_CHANNEL_MAP: dict[str, str] = {
    # Shopify variants
    "shopify": SHOPIFY,
    "shopify_api": SHOPIFY,
    "shopify_orders": SHOPIFY,
    "shopify_csv": SHOPIFY,
    # Amazon variants
    "amazon": AMAZON,
    "amazon_inventory": AMAZON,
    "amazon_sales": AMAZON,
    "amazon_custom_combined_tax": AMAZON,
    "amazon_tax_report": AMAZON,
    "amazon_spapi": AMAZON,
}


def normalize_channel(raw: str) -> str:
    """Map any source / file_type / channel string to its canonical channel."""
    key = raw.strip().lower()
    if key in _CHANNEL_MAP:
        return _CHANNEL_MAP[key]
    if key.startswith("shopify"):
        return SHOPIFY
    if key.startswith("amazon"):
        return AMAZON
    return key


def is_marketplace(channel: str) -> bool:
    """True if the channel is a marketplace facilitator (Amazon).

    Marketplace facilitators collect and remit sales tax on the seller's
    behalf in all 45 sales-tax states + DC.
    """
    return normalize_channel(channel) == AMAZON


def display_label(channel: str) -> str:
    """Human-readable label for a channel."""
    canon = normalize_channel(channel)
    return {SHOPIFY: "Shopify", AMAZON: "Amazon FBA"}.get(canon, channel.title())
