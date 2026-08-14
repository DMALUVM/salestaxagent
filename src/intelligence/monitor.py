"""
Source monitoring and change detection.

Periodically checks curated URLs for content changes and flags
updates for human review.
"""
from __future__ import annotations

import hashlib
from datetime import datetime

import httpx

from src.db import fetch_all, insert_rows, update_row, log_audit


def check_source_for_changes(source_id: str, url: str, state_code: str | None = None) -> dict:
    """Fetch a URL, hash its content, and compare to last known hash."""
    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True, headers={
            "User-Agent": "SalesTaxComplianceAgent/1.0 (private research tool)"
        })
        if resp.status_code != 200:
            return {
                "change_detected": False,
                "error": f"HTTP {resp.status_code}",
                "url": url,
            }

        content = resp.text
        current_hash = hashlib.sha256(content.encode()).hexdigest()[:32]

    except Exception as e:
        return {
            "change_detected": False,
            "error": str(e),
            "url": url,
        }

    sources = fetch_all("source_registry")
    source = None
    for s in sources:
        if str(s.get("id")) == source_id:
            source = s
            break

    previous_hash = source.get("last_content_hash") if source else None
    change_detected = previous_hash is not None and current_hash != previous_hash

    insert_rows("monitoring_checks", [{
        "source_registry_id": source_id,
        "url": url,
        "state_code": state_code,
        "check_type": "hash_check",
        "previous_hash": previous_hash,
        "current_hash": current_hash,
        "change_detected": change_detected,
        "change_summary": "Content hash changed — review needed" if change_detected else None,
        "requires_review": change_detected,
    }])

    if source:
        update_data = {
            "last_checked": datetime.utcnow().isoformat(),
            "last_content_hash": current_hash,
        }
        if change_detected:
            update_data["last_change_detected"] = datetime.utcnow().isoformat()
        update_row("source_registry", {"id": source_id}, update_data)

    if change_detected:
        insert_rows("research_tasks", [{
            "title": f"Source change detected: {source.get('title', url) if source else url}",
            "description": f"Content change detected at {url}. Previous hash: {previous_hash}, "
                           f"new hash: {current_hash}. Review for rule or threshold changes.",
            "state_code": state_code,
            "priority": "high",
            "task_type": "review_source_change",
            "source_reference": url,
            "status": "open",
        }])

    return {
        "url": url,
        "change_detected": change_detected,
        "previous_hash": previous_hash,
        "current_hash": current_hash,
        "state_code": state_code,
    }


def run_monitoring_cycle(frequency_filter: str | None = None) -> dict:
    """
    Run change detection on all active sources in the registry.
    Optionally filter by check_frequency (weekly, biweekly, monthly, quarterly).
    """
    sources = fetch_all("source_registry")
    active = [s for s in sources if s.get("is_active", True)]

    if frequency_filter:
        active = [s for s in active if s.get("check_frequency") == frequency_filter]

    results = {
        "sources_checked": 0,
        "changes_detected": 0,
        "errors": 0,
        "details": [],
    }

    for source in active:
        source_id = str(source["id"])
        url = source.get("url", "")
        state_code = source.get("state_code")

        if not url:
            continue

        result = check_source_for_changes(source_id, url, state_code)
        results["sources_checked"] += 1

        if result.get("error"):
            results["errors"] += 1
        elif result.get("change_detected"):
            results["changes_detected"] += 1

        results["details"].append({
            "title": source.get("title", url),
            "state": state_code,
            "change": result.get("change_detected", False),
            "error": result.get("error"),
        })

    log_audit(
        action="monitoring_cycle",
        category="intelligence",
        details={
            "sources_checked": results["sources_checked"],
            "changes_detected": results["changes_detected"],
            "errors": results["errors"],
            "frequency_filter": frequency_filter,
        },
    )

    return results


def get_unreviewed_changes() -> list[dict]:
    """Return monitoring checks with detected changes that haven't been reviewed."""
    checks = fetch_all("monitoring_checks")
    return [
        c for c in checks
        if c.get("change_detected") and c.get("requires_review") and not c.get("reviewed")
    ]


def mark_change_reviewed(check_id: str, notes: str | None = None) -> dict | None:
    """Mark a monitoring check as reviewed."""
    return update_row(
        "monitoring_checks",
        {"id": check_id},
        {"reviewed": True, "review_notes": notes},
    )
