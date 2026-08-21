"""SQP readers must never silently truncate history.

`sqp_weekly` holds one row per (asin, query, week) — 600-900 rows per week, and
24,000+ rows overall while the backfill runs. Two independent defects hid the
oldest weeks:

  - ordering by `week_start` alone left page boundaries undefined, so rows
    dropped and duplicated across 25 pages;
  - a `len(rows) > 20000` guard combined with DESC ordering discarded the
    OLDEST rows once the table outgrew it. The CLI reported 30 weeks while the
    dashboard and the PPC brief reported 33 from the same table.

A row cap is not forbidden. A SILENT one is.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _brand_share_block() -> str:
    src = (ROOT / "src" / "main.py").read_text()
    start = src.index('@cli.command("brand-share")')
    return src[start: src.index("\n@cli.", start + 10)]


def _code(s: str) -> str:
    return "\n".join(ln for ln in s.splitlines() if not ln.strip().startswith("#"))


def test_brand_share_pagination_orders_by_a_unique_key():
    block = _code(_brand_share_block())
    orders = re.findall(r'\.order\(\s*"([a-z_]+)"', block)
    assert "week_start" in orders
    assert any(c != "week_start" for c in orders), (
        "week_start alone leaves page boundaries undefined — hundreds of rows "
        "share each week")


def test_brand_share_never_truncates_silently():
    block = _code(_brand_share_block())
    assert "20000" not in block.replace("200_000", ""), (
        "the 20k cap dropped the oldest weeks once the table outgrew it")
    assert "truncated" in block, "a cap that is hit must be reported"
    assert "WARNING" in _brand_share_block(), (
        "truncation must be visible in the output, not just in a variable")


def test_every_sqp_weekly_reader_paginates():
    """A bare select would return the newest-or-oldest 1000 rows and stop."""
    for rel in ("src/main.py", "src/amazon_ads/export_brief.py"):
        src = (ROOT / rel).read_text()
        for m in re.finditer(r'table\(\s*"sqp_weekly"\s*\)\s*\.select\(', src):
            tail = src[m.start(): m.start() + 400]
            assert ".range(" in tail or ".limit(" in tail, (
                f"{rel}: unbounded sqp_weekly select at offset {m.start()}")
