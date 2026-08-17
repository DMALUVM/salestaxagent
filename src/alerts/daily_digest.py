"""Morning Telegram digest — yesterday's sales + MTD + next filing.

Single message, at most one per calendar day.

Primary data source: sales_daily table (real calendar-day totals).
Fallback: sales_by_state monthly aggregates (labelled as such).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from src.channels import normalize_channel, SHOPIFY, AMAZON
from src.config import settings
from src.db import fetch_all


# ---------------------------------------------------------------------------
# sales_daily helpers
# ---------------------------------------------------------------------------

def _fetch_sales_daily(start: date, end: date) -> list[dict]:
    """Fetch from sales_daily; returns [] if the table doesn't exist."""
    try:
        from src.sales_daily import fetch_daily
        return fetch_daily(start, end)
    except Exception:
        return []


def _sum_daily(rows: list[dict]) -> tuple[float, float, int, int]:
    """Sum sales_daily rows by channel.

    Returns (shopify_total, amazon_total, shopify_orders, amazon_orders).
    """
    shop = amz = 0.0
    shop_n = amz_n = 0
    for r in rows:
        ch = r.get("channel", "")
        amt = float(r.get("gross_sales", 0) or 0)
        cnt = int(r.get("order_count", 0) or 0)
        if ch == SHOPIFY:
            shop += amt
            shop_n += cnt
        elif ch == AMAZON:
            amz += amt
            amz_n += cnt
    return shop, amz, shop_n, amz_n


# ---------------------------------------------------------------------------
# sales_by_state fallback helpers
# ---------------------------------------------------------------------------

def _dedup_sales(records: list[dict]) -> list[dict]:
    """Deduplicate Amazon records: prefer amazon_spapi over
    amazon_custom_combined_tax so we never double-count."""
    spapi_keys: set[tuple] = set()
    for r in records:
        src = (r.get("source") or "").lower()
        if "spapi" in src:
            key = (r.get("state_code"), r.get("period_start"), r.get("period_end"))
            spapi_keys.add(key)

    out = []
    for r in records:
        src = (r.get("source") or "").lower()
        ch = normalize_channel(r.get("channel", ""))
        if ch == AMAZON and "custom" in src:
            key = (r.get("state_code"), r.get("period_start"), r.get("period_end"))
            if key in spapi_keys:
                continue
        out.append(r)
    return out


def _sum_channel(records: list[dict]) -> tuple[float, float]:
    """Sum gross_sales from sales_by_state split by channel."""
    shop = amz = 0.0
    for r in records:
        ch = normalize_channel(r.get("channel", ""))
        amt = float(r.get("gross_sales", 0) or 0)
        if ch == SHOPIFY:
            shop += amt
        elif ch == AMAZON:
            amz += amt
    return shop, amz


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------

def build_digest_message(
    ref_date: date | None = None,
    dry_run: bool = False,
) -> str | None:
    """Build the morning digest message. Returns None if no data."""
    if ref_date is None:
        ref_date = date.today()

    yesterday = ref_date - timedelta(days=1)
    mtd_start = yesterday.replace(day=1)
    yoy_date = yesterday - timedelta(weeks=52)  # same weekday last year
    yoy_mtd_start = yoy_date.replace(day=1)

    # ── Try sales_daily first ──────────────────────────────────
    yd_rows = _fetch_sales_daily(yesterday, yesterday)
    mtd_rows = _fetch_sales_daily(mtd_start, yesterday)
    yoy_rows = _fetch_sales_daily(yoy_date, yoy_date)

    has_daily = len(yd_rows) > 0

    if has_daily:
        y_shop, y_amz, y_shop_n, y_amz_n = _sum_daily(yd_rows)
        mtd_shop, mtd_amz, _, _ = _sum_daily(mtd_rows)
        has_daily_mtd = len(mtd_rows) > 0

        if yoy_rows:
            yoy_shop, yoy_amz, _, _ = _sum_daily(yoy_rows)
            yoy_total = yoy_shop + yoy_amz
        else:
            yoy_total = 0.0
    else:
        # ── Fallback to sales_by_state ─────────────────────────
        y_shop = y_amz = 0.0
        y_shop_n = y_amz_n = 0
        yoy_total = 0.0

        sales = _dedup_sales(fetch_all("sales_by_state"))
        monthly_records = []
        for r in sales:
            ps = str(r.get("period_start", ""))
            pe = str(r.get("period_end", ""))
            if not ps:
                continue
            if ps <= yesterday.isoformat() and pe >= mtd_start.isoformat():
                monthly_records.append(r)
        mtd_shop, mtd_amz = _sum_channel(monthly_records)
        has_daily_mtd = False

    # ── YoY string ─────────────────────────────────────────────
    y_total = y_shop + y_amz
    if has_daily and yoy_total > 0:
        yoy_pct = (y_total / yoy_total - 1) * 100
        yoy_str = f"{yoy_pct:+.0f}% vs same weekday last year"
    else:
        yoy_str = "n/a"

    # ── Next filing due within 14 days ─────────────────────────
    from src.alerts.telegram_policy import compute_next_due
    from src.config import load_state_rules
    rules = load_state_rules().get("states", {})
    nexus = fetch_all("nexus_status")

    filing_line = ""
    for n in sorted(nexus, key=lambda x: x.get("state_code", "")):
        if not n.get("is_registered"):
            continue
        nd = compute_next_due(
            n.get("last_filed_through"),
            n.get("assigned_frequency"),
            rules.get(n["state_code"], {}).get("typical_due_day", 20),
        )
        if nd and 0 <= nd["days_until"] <= 14:
            filing_line = (
                f"\n📅 Next filing: {n['state_code']} due {nd['due_date']} "
                f"({nd['days_until']}d)"
            )
            break

    # ── Build message ──────────────────────────────────────────
    parts = [f"☀️ <b>Daily Digest — {yesterday.strftime('%b %d')}</b>", ""]

    if has_daily:
        parts.append(f"Yesterday: <b>${y_total:,.0f}</b> ({yoy_str})")
        parts.append(f"  Shopify ${y_shop:,.0f} · Amazon ${y_amz:,.0f}")
    else:
        parts.append(
            "<i>Daily breakdown unavailable; showing month-to-date only.</i>"
        )

    parts.append("")

    if has_daily_mtd:
        parts.append(f"MTD ({mtd_start.strftime('%b')}):")
        parts.append(
            f"  Shopify ${mtd_shop:,.0f} · Amazon ${mtd_amz:,.0f} "
            f"· Total ${mtd_shop + mtd_amz:,.0f}"
        )
    elif mtd_shop + mtd_amz > 0:
        parts.append(f"MTD ({mtd_start.strftime('%b')}) — monthly aggregate:")
        parts.append(
            f"  Shopify ${mtd_shop:,.0f} · Amazon ${mtd_amz:,.0f} "
            f"· Total ${mtd_shop + mtd_amz:,.0f}"
        )

    if filing_line:
        parts.append(filing_line)

    parts.append(
        "\n<i>Amazon: item-price by purchase-date, Pacific tz, excl. cancelled. "
        "Shopify: subtotal by created_at, Eastern tz. Not tax advice.</i>"
    )

    # ── Dry-run diagnostics ────────────────────────────────────
    if dry_run:
        diag = [
            "",
            "--- dry-run diagnostics ---",
            f"ref_date:            {ref_date}",
            f"yesterday:           {yesterday}",
            f"data_source:         {'sales_daily' if has_daily else 'sales_by_state (monthly fallback)'}",
            f"yesterday_rows:      {len(yd_rows)}",
            f"mtd_rows:            {len(mtd_rows)}",
            f"yoy_rows:            {len(yoy_rows)}",
        ]
        if has_daily:
            diag.append(f"shopify_orders:      {y_shop_n}")
            diag.append(f"amazon_orders:       {y_amz_n}")
        diag.append(f"date_range_mtd:      {mtd_start} .. {yesterday}")
        if has_daily and has_daily_mtd:
            diag.append(
                f"sanity_check:        MTD ${mtd_shop + mtd_amz:,.0f} "
                f">= Yesterday ${y_total:,.0f} -> "
                f"{'OK' if mtd_shop + mtd_amz >= y_total - 0.01 else 'FAIL'}"
            )
        # Show date min/max from mtd_rows
        if mtd_rows:
            dates = sorted(set(r.get("sale_date", "") for r in mtd_rows))
            diag.append(f"mtd_date_range:      {dates[0]} .. {dates[-1]} ({len(dates)} days)")
        parts.extend(diag)

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Sender
# ---------------------------------------------------------------------------

def send_digest(dry_run: bool = False) -> dict:
    """Build and send the morning digest. Dedupes to one per day."""
    from src.alerts.telegram_policy import dedupe_key, _was_recently_sent
    from src.alerts.telegram import send_telegram
    from src.db import insert_rows

    key = dedupe_key("daily_digest", "all", date.today().isoformat())
    if _was_recently_sent(key, hours=20):
        return {"sent": False, "reason": "already sent today"}

    msg = build_digest_message()
    if not msg:
        return {"sent": False, "reason": "no data"}

    if dry_run:
        return {"sent": False, "dry_run": True, "message": msg}

    result = send_telegram(msg)

    try:
        insert_rows("alerts", [{
            "alert_type": "daily_digest",
            "channel": "telegram",
            "subject": f"Daily digest {date.today()}",
            "body": msg,
            "severity": "info",
            "delivered": result.get("sent", False),
            "dedupe_key": key,
        }])
    except Exception:
        insert_rows("alerts", [{
            "alert_type": "daily_digest",
            "channel": "telegram",
            "subject": f"Daily digest {date.today()}",
            "body": msg,
            "severity": "info",
            "delivered": result.get("sent", False),
        }])

    return result
