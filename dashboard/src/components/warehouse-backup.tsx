"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertTriangle,
  CheckCircle,
  Database,
  Download,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

interface RestoreTableRow {
  table: string;
  rows_in_backup: number;
  upserted: number;
  status: string;
  error?: string;
}

interface RestoreResponse {
  ok: boolean;
  error?: string;
  dry_run?: boolean;
  exported_at?: string;
  tables_processed?: number;
  total_upserted?: number;
  unknown_tables?: string[];
  errors?: Array<{ table: string; error: string }>;
  tables?: RestoreTableRow[];
}

export function WarehouseBackupCard({ onComplete }: { onComplete?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [selected, setSelected] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<RestoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/warehouse/snapshot");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ??
        "warehouse_snapshot.json.gz";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  function pickFile(files: FileList | null) {
    if (!files?.length) return;
    const file = files[0];
    const name = file.name.toLowerCase();
    if (!name.endsWith(".gz") && !name.endsWith(".json")) {
      setError("Upload a warehouse snapshot (.json.gz or .json).");
      return;
    }
    setSelected(file);
    setConfirmed(false);
    setResult(null);
    setError(null);
  }

  async function handleRestore(dryRun: boolean) {
    if (!selected) return;
    if (!dryRun && !confirmed) {
      setError("Confirm you understand restore merges data before uploading.");
      return;
    }
    setRestoring(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", selected);
      const url = dryRun ? "/api/warehouse/snapshot?dry_run=1" : "/api/warehouse/snapshot";
      const res = await fetch(url, { method: "POST", body: fd });
      const json = (await res.json()) as RestoreResponse;
      if (!res.ok || !json.ok && !dryRun) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setResult(json);
      if (!dryRun && json.ok) {
        setSelected(null);
        setConfirmed(false);
        onComplete?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4 text-muted-foreground" />
          Full Warehouse Backup & Restore
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Download a gzip JSON bundle of every operational Supabase table the dashboard uses
          (sales, P&amp;L, ads, inventory, filings, paid intel, and more). Restore upserts rows
          from the file — it does not delete data that exists only in the live warehouse.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleDownload} disabled={downloading}>
            {downloading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            Download full backup
          </Button>
        </div>

        <div className="rounded-lg border border-dashed p-4 space-y-3">
          <p className="text-sm font-medium">Restore from backup file</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={restoring}
            >
              Browse…
            </Button>
            {selected && (
              <span className="text-xs text-muted-foreground">
                {selected.name} ({(selected.size / (1024 * 1024)).toFixed(1)} MB)
              </span>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".gz,.json,application/gzip,application/json"
            className="hidden"
            onChange={(e) => pickFile(e.target.files)}
          />
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I understand restore <strong>merges</strong> backup rows into Supabase (upsert).
              Rows not in the backup stay in the database. For catastrophic loss, also keep
              Supabase project backups / PITR.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!selected || restoring}
              onClick={() => handleRestore(true)}
            >
              Validate (dry run)
            </Button>
            <Button
              size="sm"
              disabled={!selected || restoring}
              onClick={() => handleRestore(false)}
            >
              {restoring ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="mr-1.5 h-3.5 w-3.5" />
              )}
              Restore backup
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div
            className={`rounded-lg border p-4 text-xs ${
              result.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            }`}
          >
            <div className="flex items-start gap-2">
              {result.ok ? (
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="space-y-2 min-w-0">
                <p className="font-medium">
                  {result.dry_run ? "Dry run complete" : "Restore complete"}
                  {result.exported_at ? ` — snapshot ${result.exported_at.slice(0, 10)}` : ""}
                </p>
                <p>
                  {result.tables_processed ?? 0} tables ·{" "}
                  {(result.total_upserted ?? 0).toLocaleString()} rows upserted
                </p>
                {(result.errors?.length ?? 0) > 0 && (
                  <ul className="space-y-0.5">
                    {result.errors?.map((e) => (
                      <li key={e.table}>{e.table}: {e.error}</li>
                    ))}
                  </ul>
                )}
                {(result.tables?.length ?? 0) > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded border bg-background/50 p-2 font-mono text-[10px]">
                    {result.tables?.map((t) => (
                      <div key={t.table}>
                        {t.table}: {t.rows_in_backup} → {t.upserted} ({t.status})
                        {t.error ? ` ${t.error}` : ""}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          CLI:{" "}
          <code className="rounded bg-muted px-1">python -m src.main warehouse-export</code> and{" "}
          <code className="rounded bg-muted px-1">warehouse-restore path/to/file.json.gz</code>
        </p>
      </CardContent>
    </Card>
  );
}
