from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

from supabase import create_client, Client

from src.config import settings


_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        if not settings.supabase_url or not settings.supabase_service_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env"
            )
        _client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _client


def _serialize(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _clean_row(row: dict) -> dict:
    return {k: _serialize(v) for k, v in row.items() if v is not None}


def upsert_rows(table: str, rows: list[dict], on_conflict: str | None = None) -> int:
    if not rows:
        return 0
    client = get_client()
    cleaned = [_clean_row(r) for r in rows]
    query = client.table(table).upsert(cleaned, on_conflict=on_conflict)
    result = query.execute()
    return len(result.data) if result.data else 0


def insert_rows(table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    client = get_client()
    cleaned = [_clean_row(r) for r in rows]
    result = client.table(table).insert(cleaned).execute()
    return len(result.data) if result.data else 0


def fetch_all(table: str, filters: dict | None = None, order: str | None = None) -> list[dict]:
    client = get_client()
    query = client.table(table).select("*")
    if filters:
        for key, value in filters.items():
            query = query.eq(key, value)
    if order:
        query = query.order(order)
    result = query.execute()
    return result.data or []


def fetch_one(table: str, filters: dict) -> dict | None:
    client = get_client()
    query = client.table(table).select("*")
    for key, value in filters.items():
        query = query.eq(key, value)
    result = query.limit(1).execute()
    return result.data[0] if result.data else None


def update_row(table: str, filters: dict, updates: dict) -> dict | None:
    client = get_client()
    query = client.table(table).update(_clean_row(updates))
    for key, value in filters.items():
        query = query.eq(key, value)
    result = query.execute()
    return result.data[0] if result.data else None


def log_audit(action: str, category: str, details: dict | None = None,
              source_file: str | None = None, rows_affected: int | None = None,
              state_code: str | None = None) -> None:
    row = {
        "action": action,
        "category": category,
        "details": json.dumps(details) if details else None,
        "source_file": source_file,
        "rows_affected": rows_affected,
        "state_code": state_code,
    }
    insert_rows("audit_log", [row])


def log_ingestion(filename: str, file_type: str, file_hash: str | None = None,
                  rows_total: int = 0, rows_inserted: int = 0, rows_skipped: int = 0,
                  warnings: list | None = None, status: str = "success",
                  error_message: str | None = None) -> None:
    row = {
        "filename": filename,
        "file_type": file_type,
        "file_hash": file_hash,
        "rows_total": rows_total,
        "rows_inserted": rows_inserted,
        "rows_skipped": rows_skipped,
        "warnings": json.dumps(warnings) if warnings else None,
        "status": status,
        "error_message": error_message,
    }
    insert_rows("ingestion_log", [row])
