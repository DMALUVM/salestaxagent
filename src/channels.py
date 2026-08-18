"""Canonical channel and source identifiers for sales data.

Channel taxonomy for tax liability:

  shopify          — Online Store / website orders. SELLER remits tax.
  shopify_shop     — Shop channel / Shop app orders (source_name is a
                     numeric app-id like "3890849"). Since 2025-01-01
                     SHOPIFY remits tax as marketplace facilitator.
                     Still counts toward economic nexus thresholds.
  amazon           — FBA / Seller Central. AMAZON remits as facilitator.
  other            — manual / draft / subscription / unknown.

Key rule: Shop Pay on website ≠ Shop channel. A web order paid via
Shop Pay is source_name="web" → shopify (seller-responsible). Only
orders originating FROM the Shop app have the numeric source_name.
"""
from __future__ import annotations

from datetime import date

# Canonical channel names
SHOPIFY = "shopify"            # seller-responsible (Online Store / web)
SHOPIFY_SHOP = "shopify_shop"  # Shopify-remits (Shop channel, since 2025-01-01)
SHOPIFY_SUB = "shopify_sub"    # subscription contract (tax handled by sub platform)
AMAZON = "amazon"              # Amazon-remits
OTHER = "other"

# Date after which Shop channel orders are marketplace-facilitated
SHOP_CHANNEL_MARKETPLACE_START = date(2025, 1, 1)

# Known Shop channel app IDs (numeric source_name values)
_SHOP_APP_IDS = {"3890849"}

# Maps any known source / file_type / channel string to its canonical channel
_CHANNEL_MAP: dict[str, str] = {
    # Shopify variants (seller-responsible)
    "shopify": SHOPIFY,
    "shopify_api": SHOPIFY,
    "shopify_orders": SHOPIFY,
    "shopify_csv": SHOPIFY,
    # Shop channel (Shopify-remits)
    "shopify_shop": SHOPIFY_SHOP,
    "shop_channel": SHOPIFY_SHOP,
    # Subscription contracts
    "shopify_sub": SHOPIFY_SUB,
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


def classify_shopify_order(source_name: str, order_date: date | None = None) -> str:
    """Classify a Shopify order as seller-responsible or Shop-channel.

    Args:
        source_name: Shopify order source_name field (e.g. "web", "3890849")
        order_date:  Order creation date (Shop channel marketplace starts 2025-01-01)

    Returns:
        SHOPIFY ("shopify") for seller-responsible orders
        SHOPIFY_SHOP ("shopify_shop") for Shop channel orders after cutoff
    """
    sn = (source_name or "").strip()

    # Shop channel: numeric app ID in _SHOP_APP_IDS
    if sn in _SHOP_APP_IDS:
        if order_date and order_date >= SHOP_CHANNEL_MARKETPLACE_START:
            return SHOPIFY_SHOP
        # Before 2025-01-01: seller-responsible even via Shop app
        return SHOPIFY

    # Subscription contract orders: tax handled by subscription platform,
    # not included in Shopify jurisdiction tax report totals
    if sn.startswith("subscription_contract"):
        return SHOPIFY_SUB

    # Everything else (web, shopify_draft_order, etc.) = seller-responsible
    return SHOPIFY


def is_marketplace(channel: str) -> bool:
    """True if the channel is a marketplace facilitator.

    Amazon remits in all 45 sales-tax states + DC.
    Shopify Shop channel remits since 2025-01-01.
    Subscription contracts: tax handled by sub platform (not marketplace,
    but also not in seller jurisdiction report totals).
    """
    c = normalize_channel(channel)
    return c in (AMAZON, SHOPIFY_SHOP)


def is_seller_responsible(channel: str) -> bool:
    """True if the SELLER must remit tax for this channel.

    Excludes: Amazon (marketplace), Shop channel (marketplace),
    subscription contracts (tax handled by sub platform), and other.
    Matches Shopify jurisdiction tax report totals.
    """
    c = normalize_channel(channel)
    return c == SHOPIFY  # only Online Store / web orders


def display_label(channel: str) -> str:
    """Human-readable label for a channel."""
    canon = normalize_channel(channel)
    labels = {
        SHOPIFY: "Shopify (seller)",
        SHOPIFY_SHOP: "Shop Channel (Shopify remits)",
        SHOPIFY_SUB: "Subscription (sub platform)",
        AMAZON: "Amazon FBA (Amazon remits)",
    }
    return labels.get(canon, channel.title())
