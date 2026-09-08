"""Durable registry of in-flight Ads Reporting v3 report ids.

Amazon has no list-all-reports API. A launchd SIGKILL / kickstart leaves
PENDING reports occupying the reporting slot (HTTP 425) until someone
cancels a known id. This file is that known-id list.

Observe-only Ads writes: register on create, DELETE on cancel, clear on
COMPLETE / FAILURE. Never bids, budgets, negatives, or campaign status.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent

_KIND_BY_REPORT_TYPE = {
    "spSearchTerm": "search_terms",
    "sbSearchTerm": "search_terms",
    "sdSearchTerm": "search_terms",
}

_PATH_OVERRIDE: Path | None = None
_io_lock = threading.Lock()


def pending_reports_path() -> Path:
    if _PATH_OVERRIDE is not None:
        return _PATH_OVERRIDE
    override = os.environ.get("ADS_PENDING_REPORTS_PATH")
    if override:
        return Path(override)
    return ROOT / "logs" / "ads_pending_reports.json"


def kind_from_config(config: dict | None) -> str:
    """Map a Reporting v3 body to campaigns / search_terms / placements."""
    cfg = config or {}
    conf = cfg.get("configuration") or {}
    report_type = str(conf.get("reportTypeId") or "")
    if report_type in _KIND_BY_REPORT_TYPE:
        return _KIND_BY_REPORT_TYPE[report_type]
    group_by = conf.get("groupBy") or []
    if isinstance(group_by, str):
        group_by = [group_by]
    joined = " ".join(str(g) for g in group_by).lower()
    if "searchterm" in joined.replace("_", "") or "search term" in joined:
        return "search_terms"
    if "placement" in joined:
        return "placements"
    return "campaigns"


def _empty_payload() -> dict:
    return {"reports": []}


def _read_unlocked(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return _empty_payload()
    except Exception as e:
        log.warning("Ads pending-report registry unreadable (%s) — starting empty", e)
        return _empty_payload()
    if not isinstance(data, dict):
        return _empty_payload()
    rows = data.get("reports")
    if not isinstance(rows, list):
        return _empty_payload()
    return {"reports": [r for r in rows if isinstance(r, dict) and r.get("report_id")]}


def _write_unlocked(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)


def read_pending_reports() -> list[dict]:
    with _io_lock:
        return list(_read_unlocked(pending_reports_path())["reports"])


def register_pending_report(
    report_id: str,
    *,
    config: dict | None = None,
    kind: str | None = None,
    ad_product: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict | None:
    """Persist a just-created report id so a later 425 can cancel it."""
    if not report_id:
        return None
    cfg = config or {}
    conf = cfg.get("configuration") or {}
    entry = {
        "report_id": str(report_id),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "kind": kind or kind_from_config(cfg),
        "ad_product": ad_product or conf.get("adProduct") or "",
        "start_date": start_date or cfg.get("startDate") or "",
        "end_date": end_date or cfg.get("endDate") or "",
    }
    path = pending_reports_path()
    with _io_lock:
        payload = _read_unlocked(path)
        payload["reports"] = [
            r for r in payload["reports"] if r.get("report_id") != entry["report_id"]
        ]
        payload["reports"].append(entry)
        try:
            _write_unlocked(path, payload)
        except Exception as e:
            log.warning("Ads pending-report register failed for %s: %s",
                        report_id, e)
            return entry
    log.info("Ads pending report registered: %s kind=%s product=%s %s→%s",
             entry["report_id"], entry["kind"], entry["ad_product"],
             entry["start_date"], entry["end_date"])
    return entry


def clear_pending_report(report_id: str) -> bool:
    """Drop one id after COMPLETE / FAILURE / successful cancel."""
    if not report_id:
        return False
    path = pending_reports_path()
    with _io_lock:
        payload = _read_unlocked(path)
        before = len(payload["reports"])
        payload["reports"] = [
            r for r in payload["reports"] if r.get("report_id") != str(report_id)
        ]
        if len(payload["reports"]) == before:
            return False
        try:
            _write_unlocked(path, payload)
        except Exception as e:
            log.warning("Ads pending-report clear failed for %s: %s", report_id, e)
            return False
    return True


def cancel_persisted_pending_reports() -> dict:
    """Best-effort DELETE of every persisted PENDING id. No wait-loop.

    Reporting-queue cleanup only. Clears an id when cancel returns success
    (including 404 — already gone). Keeps an id when cancel fails so the
    next 425 can try again.
    """
    from src.amazon_ads.client import cancel_report

    rows = read_pending_reports()
    cancelled: list[str] = []
    failed: list[str] = []
    for row in rows:
        rid = str(row.get("report_id") or "")
        if not rid:
            continue
        ok = False
        try:
            ok = bool(cancel_report(rid))
        except Exception as e:
            log.warning("Ads pending report %s cancel raised: %s", rid, e)
            ok = False
        if ok:
            clear_pending_report(rid)
            cancelled.append(rid)
        else:
            failed.append(rid)
    if rows:
        log.info("Ads pending-report sweep: cancelled=%s failed=%s",
                 cancelled, failed)
    return {
        "cancelled": cancelled,
        "failed": failed,
        "attempted": [str(r.get("report_id") or "") for r in rows],
    }
