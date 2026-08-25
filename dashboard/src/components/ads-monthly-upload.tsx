"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CheckCircle,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { AdsMonthlyPersistResult } from "@/lib/ads-monthly-ingest";

interface UploadResponse {
  ok: boolean;
  error?: string;
  files_received?: number;
  files_ok?: number;
  files_failed?: number;
  months_upserted?: number;
  month_starts?: string[];
  total_spend?: number;
  files?: AdsMonthlyPersistResult[];
  warnings?: string[];
}

function fmtMoney(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthLabel(periodStart: string) {
  const [y, m] = periodStart.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString(undefined, { month: "short", year: "numeric" });
}

export function AdsMonthlyUpload({ onComplete }: { onComplete?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<File[]>([]);
  const [receipt, setReceipt] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    const allowed = Array.from(files).filter((f) => {
      const ext = f.name.split(".").pop()?.toLowerCase();
      return ext === "csv" || ext === "txt" || ext === "tsv";
    });
    if (!allowed.length) {
      setError("Only CSV / TXT / TSV files. Export SKU Economics as CSV from Seller Central.");
      return;
    }
    if (allowed.length < files.length) {
      setError(`${files.length - allowed.length} file(s) skipped — not CSV/TXT/TSV.`);
    } else {
      setError(null);
    }
    setSelected(allowed);
    setReceipt(null);
  }

  async function upload() {
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const fd = new FormData();
      for (const f of selected) fd.append("files", f, f.name);
      const res = await fetch("/api/upload/ads-monthly", { method: "POST", body: fd });
      const json = (await res.json()) as UploadResponse;
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setReceipt(json);
      setSelected([]);
      onComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          Upload monthly Amazon ad spend
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Seller Central → Reports → <strong>SKU Economics</strong>. Use{" "}
          <strong>Monthly</strong> aggregation (or one calendar month per file).
          Reports start <strong>September 2024</strong> — earlier ad months need Ads Console.
          Sponsored Products charge column required. Fills the Ads column on Month/Year
          when the Ads API has no history (~95 days).
        </p>

        <div
          className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pickFiles(e.dataTransfer.files);
          }}
        >
          <Upload className="mb-2 h-7 w-7 text-muted-foreground/50" />
          <p className="text-sm font-medium">
            {selected.length
              ? `${selected.length} file${selected.length === 1 ? "" : "s"} ready`
              : "Drop SKU Economics CSVs here"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Multiple months at once — March.csv, April.csv, …
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Browse
            </Button>
            {selected.length > 0 && (
              <Button size="sm" onClick={upload} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Importing…
                  </>
                ) : (
                  <>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Import {selected.length} file{selected.length === 1 ? "" : "s"}
                  </>
                )}
              </Button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,.tsv"
            multiple
            className="hidden"
            onChange={(e) => pickFiles(e.target.files)}
          />
        </div>

        {selected.length > 0 && (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {selected.map((f) => (
              <li key={f.name}>{f.name} ({(f.size / 1024).toFixed(0)} KB)</li>
            ))}
          </ul>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {receipt?.ok && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
            <div className="flex items-start gap-2 text-emerald-800 dark:text-emerald-300">
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-2 text-xs">
                <p className="text-sm font-medium">
                  Imported {receipt.months_upserted} month
                  {receipt.months_upserted === 1 ? "" : "s"}
                  ({receipt.files_ok}/{receipt.files_received} files) — $
                  {fmtMoney(receipt.total_spend ?? 0)} ad spend
                </p>
                {receipt.month_starts?.length && (
                  <p>
                    Months: {receipt.month_starts.map(monthLabel).join(", ")}
                  </p>
                )}
                {receipt.files?.map((f) => (
                  <div key={f.filename} className="border-t border-emerald-200/60 pt-1 dark:border-emerald-800">
                    <span className="font-medium">{f.filename}</span>
                    {f.ok ? (
                      <span>
                        {" "}
                        — {f.months} month{f.months === 1 ? "" : "s"}, $
                        {fmtMoney(f.total_spend)}
                      </span>
                    ) : (
                      <span className="text-red-700 dark:text-red-400"> — {f.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {receipt?.warnings && receipt.warnings.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <ul className="space-y-0.5">
              {receipt.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
