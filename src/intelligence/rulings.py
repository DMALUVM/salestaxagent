"""
Court and administrative ruling management.

Handles ingestion of new rulings from files, manual entry,
and status tracking.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path

from src.db import insert_rows, fetch_all, update_row, log_audit


def ingest_ruling_file(file_path: str | Path) -> dict:
    """
    Ingest a ruling document (JSON with structured ruling data).

    Expected format: JSON with either a "court_ruling" or "admin_ruling" key
    containing the ruling fields matching the schema.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    results = {"court_rulings_added": 0, "admin_rulings_added": 0, "errors": []}

    if "court_ruling" in data:
        ruling = data["court_ruling"]
        ruling.setdefault("last_reviewed", date.today().isoformat())
        ruling.setdefault("is_active", True)
        ruling.setdefault("status", "good_law")
        try:
            insert_rows("court_rulings", [ruling])
            results["court_rulings_added"] = 1
            _log_ruling_added("court_ruling", ruling.get("case_name", ""), ruling.get("states_affected", []))
        except Exception as e:
            results["errors"].append(f"Court ruling: {e}")

    if "admin_ruling" in data:
        ruling = data["admin_ruling"]
        ruling.setdefault("last_reviewed", date.today().isoformat())
        ruling.setdefault("is_active", True)
        ruling.setdefault("status", "current")
        try:
            insert_rows("admin_rulings", [ruling])
            results["admin_rulings_added"] = 1
            _log_ruling_added("admin_ruling", ruling.get("title", ""), ruling.get("states_affected", []))
        except Exception as e:
            results["errors"].append(f"Admin ruling: {e}")

    if "court_rulings" in data:
        for ruling in data["court_rulings"]:
            ruling.setdefault("last_reviewed", date.today().isoformat())
            ruling.setdefault("is_active", True)
            ruling.setdefault("status", "good_law")
            try:
                insert_rows("court_rulings", [ruling])
                results["court_rulings_added"] += 1
                _log_ruling_added("court_ruling", ruling.get("case_name", ""), ruling.get("states_affected", []))
            except Exception as e:
                results["errors"].append(f"Court ruling '{ruling.get('case_name', '?')}': {e}")

    if "admin_rulings" in data:
        for ruling in data["admin_rulings"]:
            ruling.setdefault("last_reviewed", date.today().isoformat())
            ruling.setdefault("is_active", True)
            ruling.setdefault("status", "current")
            try:
                insert_rows("admin_rulings", [ruling])
                results["admin_rulings_added"] += 1
                _log_ruling_added("admin_ruling", ruling.get("title", ""), ruling.get("states_affected", []))
            except Exception as e:
                results["errors"].append(f"Admin ruling '{ruling.get('title', '?')}': {e}")

    _register_source_document(path)

    return results


def ingest_raw_document(file_path: str | Path, jurisdiction: str | None = None,
                        document_type: str = "other") -> dict:
    """
    Register a raw document (PDF, HTML, text) for later extraction.
    The document is logged in source_documents with pending extraction status.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    content_hash = _file_hash(path)

    doc = {
        "title": path.stem.replace("_", " ").replace("-", " ").title(),
        "file_path": str(path.resolve()),
        "jurisdiction": jurisdiction,
        "document_type": document_type,
        "content_hash": content_hash,
        "extraction_status": "pending",
        "is_primary_source": document_type in ("statute", "regulation", "court_opinion", "admin_ruling", "dor_guidance"),
    }

    insert_rows("source_documents", [doc])

    insert_rows("research_tasks", [{
        "title": f"Extract and review: {path.name}",
        "description": f"New document uploaded: {path.name}. Extract relevant rules, rulings, or threshold "
                       f"changes and propose updates to the knowledge base.",
        "state_code": jurisdiction,
        "priority": "high" if document_type in ("court_opinion", "admin_ruling") else "medium",
        "task_type": "document_extraction",
        "source_reference": str(path.resolve()),
        "status": "open",
    }])

    log_audit(
        action="register_raw_document",
        category="intelligence",
        details={"filename": path.name, "type": document_type, "jurisdiction": jurisdiction},
        source_file=path.name,
    )

    return {
        "filename": path.name,
        "content_hash": content_hash,
        "extraction_status": "pending",
        "research_task_created": True,
    }


def update_ruling_status(ruling_id: str, table: str, new_status: str,
                         notes: str | None = None) -> dict | None:
    """Update the status of a court or admin ruling (e.g., overruled, superseded)."""
    valid_court = ("good_law", "limited", "overruled", "distinguishable", "appealed", "vacated", "superseded")
    valid_admin = ("current", "superseded", "withdrawn", "expired", "under_review")

    if table == "court_rulings" and new_status not in valid_court:
        return {"error": f"Invalid status for court ruling: {new_status}"}
    if table == "admin_rulings" and new_status not in valid_admin:
        return {"error": f"Invalid status for admin ruling: {new_status}"}

    existing = fetch_all(table)
    target = None
    for r in existing:
        if str(r.get("id")) == ruling_id:
            target = r
            break

    if not target:
        return {"error": f"Ruling not found: {ruling_id}"}

    old_status = target.get("status")
    updates = {"status": new_status, "last_reviewed": date.today().isoformat()}
    if notes:
        updates["status_notes"] = notes

    result = update_row(table, {"id": ruling_id}, updates)

    insert_rows("rule_changelog", [{
        "entity_type": "court_ruling" if table == "court_rulings" else "admin_ruling",
        "entity_id": ruling_id,
        "state_code": (target.get("states_affected") or [None])[0] if target.get("states_affected") else target.get("jurisdiction"),
        "change_type": "updated",
        "field_changed": "status",
        "old_value": old_status,
        "new_value": new_status,
        "change_reason": notes or f"Status changed to {new_status}",
        "triggered_by": "manual_update",
    }])

    return result


def list_rulings(ruling_type: str = "all", status_filter: str | None = None) -> dict:
    """List all rulings, optionally filtered by type and status."""
    result = {"court_rulings": [], "admin_rulings": []}

    if ruling_type in ("all", "court"):
        court = fetch_all("court_rulings")
        if status_filter:
            court = [r for r in court if r.get("status") == status_filter]
        result["court_rulings"] = court

    if ruling_type in ("all", "admin"):
        admin = fetch_all("admin_rulings")
        if status_filter:
            admin = [r for r in admin if r.get("status") == status_filter]
        result["admin_rulings"] = admin

    return result


def _log_ruling_added(ruling_type: str, name: str, states: list):
    log_audit(
        action=f"add_{ruling_type}",
        category="intelligence",
        details={"name": name, "states": states},
    )
    insert_rows("rule_changelog", [{
        "entity_type": ruling_type,
        "entity_id": "00000000-0000-0000-0000-000000000000",
        "state_code": states[0] if states else None,
        "change_type": "created",
        "change_reason": f"New {ruling_type} added: {name}",
        "triggered_by": "manual_update",
    }])


def _register_source_document(path: Path):
    insert_rows("source_documents", [{
        "title": path.stem.replace("_", " ").replace("-", " ").title(),
        "file_path": str(path.resolve()),
        "document_type": "other",
        "content_hash": _file_hash(path),
        "extraction_status": "extracted",
        "is_primary_source": False,
    }])


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]
