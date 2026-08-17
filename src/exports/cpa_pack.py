"""CPA Export Pack — zipped bundle of all CPA-ready exports.

Produces a zip file containing:
  - economic_nexus_audit.csv
  - registration_triage.csv
  - inventory_presence.csv
  - sales_by_state_detail.csv (channel-normalized)
  - nexus_status_snapshot.csv
  - franchise_flags_open.csv
  - README.txt
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

from src.channels import normalize_channel
from src.db import fetch_all


README = """\
Sales Tax Compliance — CPA Export Pack
Generated: {generated}
Period: {period}

DISCLAIMER: This is a monitoring and research aid assembled from
Amazon SP-API, Shopify API, and configured state rules. It is NOT
legal, tax, or CPA advice. Rules change. Verify against primary
state DOR authority and Seller Central before acting.

Contents:
  economic_nexus_audit.csv    — Per-state threshold analysis with marketplace rules
  registration_triage.csv     — Triage buckets for CPA discussion
  inventory_presence.csv      — FBA inventory presence by state/month
  sales_by_state_detail.csv   — All sales records (channel normalized)
  nexus_status_snapshot.csv   — Current nexus flags + registration status
  franchise_flags_open.csv    — Open franchise/entity tax flags

How to match Seller Central:
  - Orders reports ≈ Business Reports by order date (gross, pre-refund)
  - Settlement reports ≈ Payments → Settlement Period (cash/deposit view)
  - Custom Combined Tax ≈ tax jurisdiction detail, not bank deposits
  - Agent liability uses sales/nexus rules; settlements validate Amazon completeness
"""


def build_pack(
    period: str = "all",
    out_dir: str = "exports/cpa",
) -> Path:
    """Build a zipped CPA pack. Returns the path to the zip file."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    zip_path = out / f"CPA_Pack_{ts}.zip"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # README
        zf.writestr("README.txt", README.format(generated=ts, period=period))

        # Economic nexus audit
        try:
            from src.exports.economic_nexus_audit import build_audit, build_csv as econ_csv
            audit = build_audit()
            zf.writestr("economic_nexus_audit.csv", econ_csv(audit))
        except Exception as e:
            zf.writestr("economic_nexus_audit.csv", f"Error: {e}")

        # Registration triage
        try:
            from src.exports.registration_triage import build_csv as triage_csv
            zf.writestr("registration_triage.csv", triage_csv())
        except Exception as e:
            zf.writestr("registration_triage.csv", f"Error: {e}")

        # Inventory presence
        try:
            from src.exports.inventory_presence import build_csv as inv_csv
            zf.writestr("inventory_presence.csv", inv_csv())
        except Exception as e:
            zf.writestr("inventory_presence.csv", f"Error: {e}")

        # Sales by state detail (channel normalized)
        zf.writestr("sales_by_state_detail.csv", _sales_detail_csv())

        # Nexus status snapshot
        zf.writestr("nexus_status_snapshot.csv", _nexus_snapshot_csv())

        # Franchise flags
        zf.writestr("franchise_flags_open.csv", _franchise_csv())

    return zip_path


def _sales_detail_csv() -> str:
    rows = fetch_all("sales_by_state")
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["state_code", "channel_normalized", "channel_raw", "period_start",
                "period_end", "order_count", "gross_sales", "net_sales",
                "tax_collected", "source"])
    for r in sorted(rows, key=lambda x: (x.get("state_code", ""), x.get("period_start", ""))):
        w.writerow([
            r.get("state_code"), normalize_channel(r.get("channel", "")),
            r.get("channel"), r.get("period_start"), r.get("period_end"),
            r.get("order_count", 0), r.get("gross_sales", 0),
            r.get("net_sales", 0), r.get("tax_collected", 0),
            r.get("source", ""),
        ])
    return out.getvalue()


def _nexus_snapshot_csv() -> str:
    rows = fetch_all("nexus_status")
    out = io.StringIO()
    w = csv.writer(out)
    fields = ["state_code", "has_physical_nexus", "physical_nexus_since",
              "has_economic_nexus", "economic_progress_amount",
              "economic_progress_percent", "is_registered",
              "assigned_frequency", "last_filed_through", "confidence"]
    w.writerow(fields)
    for r in sorted(rows, key=lambda x: x.get("state_code", "")):
        w.writerow([r.get(f, "") for f in fields])
    return out.getvalue()


def _franchise_csv() -> str:
    rows = fetch_all("franchise_tax_flags", {"status": "open"})
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["state_code", "flag_type", "severity", "description",
                "trigger_reason", "recommended_action", "confidence"])
    for r in sorted(rows, key=lambda x: x.get("state_code", "")):
        w.writerow([r.get("state_code"), r.get("flag_type"), r.get("severity"),
                     r.get("description", "")[:200], r.get("trigger_reason", "")[:100],
                     r.get("recommended_action", "")[:200], r.get("confidence")])
    return out.getvalue()
