"""
Document extraction pipeline.

Handles structured extraction from raw documents (PDFs, HTML, text)
into proposed knowledge base updates. Designed for LLM-assisted extraction
with mandatory human review before any rule goes live.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from src.db import insert_rows, update_row, fetch_all, log_audit


EXTRACTION_PROMPT_TEMPLATE = """
You are a multi-state sales tax research assistant. Extract structured information
from the following document for a knowledge base tracking nexus rules, court rulings,
and filing obligations for US ecommerce sellers (Amazon FBA + Shopify).

Document: {filename}
Type: {document_type}
Jurisdiction: {jurisdiction}

Extract any of the following that are present:
1. Nexus rule changes (physical, economic, marketplace)
2. Court or administrative rulings
3. Threshold changes
4. Filing requirement changes
5. Franchise/entity tax implications

For each extracted item, provide:
- Type (nexus_rule, court_ruling, admin_ruling, threshold_change, filing_change)
- State(s) affected
- Summary of the change or holding
- Effective date if stated
- Primary source citation
- Confidence (high/medium/low)
- Any open questions or caveats

Return as JSON array of extracted items.

IMPORTANT: Do not invent or hallucinate citations. If the document does not
clearly state something, note it as uncertain. Err on the side of flagging
for human review rather than asserting uncertain positions.

Document text:
{content}
"""


def prepare_extraction(source_doc_id: str) -> dict:
    """
    Prepare a document for extraction by reading it and generating
    the extraction prompt. Returns the prompt for LLM processing.
    """
    docs = fetch_all("source_documents")
    doc = None
    for d in docs:
        if str(d.get("id")) == source_doc_id:
            doc = d
            break

    if not doc:
        return {"error": f"Source document not found: {source_doc_id}"}

    file_path = doc.get("file_path")
    if not file_path or not Path(file_path).exists():
        return {"error": f"Document file not found: {file_path}"}

    path = Path(file_path)
    suffix = path.suffix.lower()

    if suffix in (".txt", ".html", ".htm", ".json", ".md"):
        with open(path, "r", encoding="utf-8-sig") as f:
            content = f.read()
    else:
        content = f"[Binary file: {path.name} — manual review required]"

    prompt = EXTRACTION_PROMPT_TEMPLATE.format(
        filename=path.name,
        document_type=doc.get("document_type", "unknown"),
        jurisdiction=doc.get("jurisdiction", "unknown"),
        content=content[:50000],
    )

    return {
        "source_doc_id": source_doc_id,
        "filename": path.name,
        "prompt": prompt,
        "content_length": len(content),
    }


def store_extraction_results(source_doc_id: str, extracted_items: list[dict],
                             raw_extraction: str | None = None) -> dict:
    """
    Store extraction results as proposed updates. All items are flagged
    for human review before being applied to the knowledge base.
    """
    docs = fetch_all("source_documents")
    doc = None
    for d in docs:
        if str(d.get("id")) == source_doc_id:
            doc = d
            break

    if not doc:
        return {"error": f"Source document not found: {source_doc_id}"}

    update_row(
        "source_documents",
        {"id": source_doc_id},
        {
            "extraction_status": "extracted",
            "extracted_data": json.dumps({
                "items": extracted_items,
                "raw": raw_extraction,
                "extracted_at": date.today().isoformat(),
            }),
        },
    )

    tasks_created = 0
    for item in extracted_items:
        item_type = item.get("type", "unknown")
        states = item.get("states_affected", [])
        summary = item.get("summary", "No summary")

        insert_rows("research_tasks", [{
            "title": f"Review extracted {item_type}: {summary[:50]}",
            "description": (
                f"Extracted from {doc.get('title', 'unknown document')}.\n\n"
                f"Type: {item_type}\n"
                f"States: {', '.join(states) if states else 'Unknown'}\n"
                f"Summary: {summary}\n"
                f"Confidence: {item.get('confidence', 'unknown')}\n\n"
                f"Review this extraction and apply to the knowledge base if accurate."
            ),
            "state_code": states[0] if states else None,
            "priority": "high" if item_type in ("court_ruling", "threshold_change") else "medium",
            "task_type": "verify_rule",
            "source_reference": source_doc_id,
            "status": "open",
        }])
        tasks_created += 1

    log_audit(
        action="store_extraction",
        category="intelligence",
        details={
            "source_doc_id": source_doc_id,
            "items_extracted": len(extracted_items),
            "tasks_created": tasks_created,
        },
    )

    return {
        "source_doc_id": source_doc_id,
        "items_extracted": len(extracted_items),
        "tasks_created": tasks_created,
        "status": "extracted — pending human review",
    }


def get_pending_extractions() -> list[dict]:
    """Return source documents with pending extraction status."""
    docs = fetch_all("source_documents")
    return [d for d in docs if d.get("extraction_status") == "pending"]


def get_extracted_needing_review() -> list[dict]:
    """Return source documents that have been extracted but not reviewed."""
    docs = fetch_all("source_documents")
    return [d for d in docs if d.get("extraction_status") == "extracted"
            and not d.get("review_notes")]


def mark_extraction_reviewed(source_doc_id: str, notes: str) -> dict | None:
    """Mark a document's extraction as reviewed with notes."""
    return update_row(
        "source_documents",
        {"id": source_doc_id},
        {
            "extraction_status": "reviewed",
            "review_notes": notes,
        },
    )
