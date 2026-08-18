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


def upsert_rows(
    table: str,
    rows: list[dict],
    on_conflict: str | None = None,
    batch_size: int = 500,
) -> int:
    if not rows:
        return 0
    client = get_client()
    total = 0
    for i in range(0, len(rows), batch_size):
        batch = [_clean_row(r) for r in rows[i : i + batch_size]]
        result = (
            client.table(table)
            .upsert(batch, on_conflict=on_conflict)
            .execute()
        )
        total += len(result.data) if result.data else 0
    return total


def insert_rows(table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    client = get_client()
    cleaned = [_clean_row(r) for r in rows]
    result = client.table(table).insert(cleaned).execute()
    return len(result.data) if result.data else 0


def delete_rows(table: str, filters: dict) -> int:
    """Delete rows matching all equality filters. Returns count deleted."""
    if not filters:
        return 0
    client = get_client()
    query = client.table(table).delete()
    for key, value in filters.items():
        query = query.eq(key, value)
    result = query.execute()
    return len(result.data) if result.data else 0


def fetch_all(table: str, filters: dict | None = None, order: str | None = None) -> list[dict]:
    """Fetch all matching rows, paginating past the PostgREST 1 000-row default."""
    client = get_client()
    all_rows: list[dict] = []
    page_size = 1000
    offset = 0

    while True:
        query = client.table(table).select("*")
        if filters:
            for key, value in filters.items():
                query = query.eq(key, value)
        if order:
            query = query.order(order)
        query = query.range(offset, offset + page_size - 1)
        result = query.execute()
        page = result.data or []
        all_rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size

    return all_rows


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


# ── Supabase Storage helpers ───────────────────────────────

def job_start(job_name: str) -> str | None:
    """Record a job starting. Returns the row ID for job_finish()."""
    try:
        result = get_client().table("job_runs").insert({
            "job_name": job_name,
            "status": "running",
        }).execute()
        return result.data[0]["id"] if result.data else None
    except Exception:
        return None


def job_finish(run_id: str | None, status: str = "success",
               message: str | None = None, stats: dict | None = None) -> None:
    """Mark a job run as finished."""
    if not run_id:
        return
    try:
        from datetime import datetime, timezone
        get_client().table("job_runs").update({
            "status": status,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "message": (message or "")[:1000] if message else None,
            "stats": stats,
        }).eq("id", run_id).execute()
    except Exception:
        pass  # best-effort — don't crash the job


def ensure_storage_bucket(bucket: str) -> None:
    """Create a private storage bucket if it doesn't exist."""
    client = get_client()
    try:
        client.storage.get_bucket(bucket)
    except Exception:
        try:
            client.storage.create_bucket(bucket, options={"public": False})
        except Exception:
            pass  # bucket may already exist from a race


def upload_to_storage(bucket: str, path: str, data: bytes | bytearray, content_type: str) -> str | None:
    """Upload bytes to Supabase Storage. Returns the path on success."""
    client = get_client()
    ensure_storage_bucket(bucket)
    # Ensure data is bytes (fpdf.output() returns bytearray)
    if isinstance(data, bytearray):
        data = bytes(data)
    try:
        client.storage.from_(bucket).upload(
            path, data,
            file_options={"content-type": content_type, "upsert": "true"},
        )
        return path
    except Exception as e:
        # Retry with remove + upload if upsert not supported
        try:
            client.storage.from_(bucket).remove([path])
            client.storage.from_(bucket).upload(
                path, data,
                file_options={"content-type": content_type},
            )
            return path
        except Exception:
            print(f"Storage upload failed for {path}: {e}")
            return None


def download_from_storage(bucket: str, path: str) -> bytes | None:
    """Download a file from Supabase Storage. Returns bytes or None."""
    client = get_client()
    try:
        return client.storage.from_(bucket).download(path)
    except Exception:
        return None


def create_signed_url(bucket: str, path: str, expires_in: int = 3600) -> str | None:
    """Create a signed download URL (valid for expires_in seconds)."""
    client = get_client()
    try:
        result = client.storage.from_(bucket).create_signed_url(path, expires_in)
        return result.get("signedURL") or result.get("signedUrl")
    except Exception:
        return None
