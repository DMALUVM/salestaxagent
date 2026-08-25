"""Full Supabase warehouse snapshot export and restore.

Bundles operational dashboard tables into a single gzip JSON file. Restore
upserts rows (merge) using each table's natural unique key — it does not wipe
tables that are absent from the backup.
"""
from __future__ import annotations

import gzip
import io
import json
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from src.db import fetch_all, log_audit, upsert_rows

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "config" / "warehouse_snapshot_tables.json"
SNAPSHOT_FORMAT = "sales_tax_agent_warehouse_snapshot"
SUPPORTED_VERSIONS = {1}


def _config_path(path: Path | str | None) -> Path:
    return Path(path) if path else DEFAULT_CONFIG


def load_table_config(path: Path | str | None = None) -> dict:
    cfg_path = _config_path(path)
    with open(cfg_path, encoding="utf-8") as f:
        return json.load(f)


def table_specs(path: Path | str | None = None) -> list[dict]:
    cfg = load_table_config(path)
    tables = cfg.get("tables") or []
    return sorted(tables, key=lambda t: (t.get("restore_order", 999), t["name"]))


def _json_safe(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def _serialize_rows(rows: list[dict]) -> list[dict]:
    return [_json_safe(r) for r in rows]


def export_snapshot(
    config_path: Path | str | None = None,
    tables_filter: list[str] | None = None,
) -> dict:
    """Read all configured tables and return a snapshot dict (not gzip)."""
    specs = table_specs(config_path)
    if tables_filter:
        allow = set(tables_filter)
        specs = [s for s in specs if s["name"] in allow]

    exported_at = datetime.now(timezone.utc).isoformat()
    cfg = load_table_config(config_path)
    version = int(cfg.get("version", 1))

    tables_data: dict[str, list[dict]] = {}
    table_meta: dict[str, dict] = {}
    errors: list[dict] = []

    for spec in specs:
        name = spec["name"]
        try:
            rows = fetch_all(name)
            tables_data[name] = _serialize_rows(rows)
            table_meta[name] = {"row_count": len(rows), "status": "ok"}
        except Exception as exc:
            log.warning("warehouse export: %s failed: %s", name, exc)
            tables_data[name] = []
            table_meta[name] = {"row_count": 0, "status": "error", "error": str(exc)[:500]}
            errors.append({"table": name, "error": str(exc)[:500]})

    return {
        "format": SNAPSHOT_FORMAT,
        "version": version,
        "exported_at": exported_at,
        "table_meta": table_meta,
        "errors": errors,
        "tables": tables_data,
    }


def export_snapshot_gzip(
    output_path: Path | str,
    config_path: Path | str | None = None,
    tables_filter: list[str] | None = None,
) -> dict:
    snapshot = export_snapshot(config_path, tables_filter)
    out = Path(output_path)
    payload = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
    raw = payload.encode("utf-8")
    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out, "wb") as f:
        f.write(raw)
    return {
        "path": str(out),
        "bytes": out.stat().st_size,
        "exported_at": snapshot["exported_at"],
        "tables_ok": sum(1 for m in snapshot["table_meta"].values() if m.get("status") == "ok"),
        "tables_error": len(snapshot.get("errors") or []),
        "total_rows": sum(m.get("row_count", 0) for m in snapshot["table_meta"].values()),
    }


def _parse_snapshot_bytes(data: bytes) -> dict:
    try:
        if data[:2] == b"\x1f\x8b":
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
                text = gz.read().decode("utf-8")
        else:
            text = data.decode("utf-8")
        return json.loads(text)
    except Exception as exc:
        raise ValueError(f"Invalid warehouse snapshot file: {exc}") from exc


def validate_snapshot(snapshot: dict) -> None:
    if snapshot.get("format") != SNAPSHOT_FORMAT:
        raise ValueError(
            f"Unknown snapshot format: {snapshot.get('format')!r} "
            f"(expected {SNAPSHOT_FORMAT})"
        )
    version = snapshot.get("version")
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"Unsupported snapshot version: {version}")


def restore_snapshot(
    snapshot: dict,
    config_path: Path | str | None = None,
    dry_run: bool = False,
    tables_filter: list[str] | None = None,
) -> dict:
    """Upsert rows from a snapshot dict into Supabase."""
    validate_snapshot(snapshot)
    specs = table_specs(config_path)
    spec_by_name = {s["name"]: s for s in specs}
    tables_data = snapshot.get("tables") or {}

    if tables_filter:
        allow = set(tables_filter)
        tables_data = {k: v for k, v in tables_data.items() if k in allow}

    results: list[dict] = []
    total_upserted = 0
    errors: list[dict] = []

    for spec in specs:
        name = spec["name"]
        rows = tables_data.get(name)
        if rows is None:
            continue
        if not rows:
            results.append({"table": name, "rows_in_backup": 0, "upserted": 0, "status": "empty"})
            continue

        on_conflict = spec.get("on_conflict")
        if dry_run:
            results.append({
                "table": name,
                "rows_in_backup": len(rows),
                "upserted": 0,
                "status": "dry_run",
                "on_conflict": on_conflict,
            })
            continue

        try:
            upserted = upsert_rows(name, rows, on_conflict=on_conflict)
            total_upserted += upserted
            results.append({
                "table": name,
                "rows_in_backup": len(rows),
                "upserted": upserted,
                "status": "ok",
            })
        except Exception as exc:
            log.exception("warehouse restore: %s failed", name)
            errors.append({"table": name, "error": str(exc)[:500]})
            results.append({
                "table": name,
                "rows_in_backup": len(rows),
                "upserted": 0,
                "status": "error",
                "error": str(exc)[:500],
            })

    unknown = [t for t in tables_data if t not in spec_by_name]
    summary = {
        "dry_run": dry_run,
        "exported_at": snapshot.get("exported_at"),
        "tables_processed": len(results),
        "total_upserted": total_upserted,
        "unknown_tables": unknown,
        "errors": errors,
        "tables": results,
    }

    if not dry_run:
        try:
            log_audit(
                "warehouse_restore",
                "maintenance",
                details={
                    "exported_at": snapshot.get("exported_at"),
                    "tables_processed": len(results),
                    "total_upserted": total_upserted,
                    "errors": len(errors),
                },
                rows_affected=total_upserted,
            )
        except Exception:
            log.warning("warehouse restore audit log failed")

    return summary


def restore_snapshot_file(
    input_path: Path | str,
    config_path: Path | str | None = None,
    dry_run: bool = False,
    tables_filter: list[str] | None = None,
) -> dict:
    path = Path(input_path)
    data = path.read_bytes()
    snapshot = _parse_snapshot_bytes(data)
    result = restore_snapshot(snapshot, config_path, dry_run, tables_filter)
    result["path"] = str(path)
    return result
