"use client";

import { useEffect, useRef, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { IngestionLog, ResearchTask } from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Disclaimer } from "@/components/disclaimer";
import { AdsMonthlyUpload } from "@/components/ads-monthly-upload";
import { WarehouseBackupCard } from "@/components/warehouse-backup";
import { fileTypeLabel } from "@/lib/channels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Database,
  Upload,
  RefreshCw,
  CheckCircle,
  XCircle,
  ClipboardList,
  FolderOpen,
  FileUp,
  Loader2,
  AlertTriangle,
  FileText,
  Download,
  FileSpreadsheet,
} from "lucide-react";

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const priorityStyles: Record<string, string> = {
  critical: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
  high: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
  medium: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400",
  low: "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900 dark:text-slate-500",
};

interface UploadResult {
  success?: boolean;
  error?: string;
  report_type?: string;
  filename?: string;
  rows_total?: number;
  rows_parsed?: number;
  rows_skipped?: number;
  rows_inserted?: number;
  ship_from_rows_inserted?: number;
  unique_orders?: number;
  states_found?: string[];
  ship_from_states?: string[];
  unknown_fcs?: string[];
  total_gross_sales?: number;
  total_tax_collected?: number;
  warnings?: string[];
}

function FileUploadCard({ onComplete }: { onComplete: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "csv" && ext !== "txt" && ext !== "tsv") {
      setResult({
        success: false,
        error: "Unsupported file type. Please upload a CSV or TXT file.",
      });
      return;
    }
    setSelectedFile(file);
    setResult(null);
  }

  async function handleUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setProgress(10);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("type", "amazon");

      setProgress(30);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      setProgress(80);

      const data: UploadResult = await response.json();

      setProgress(100);
      setResult(data);
      setSelectedFile(null);

      if (data.success) {
        onComplete();
      }
    } catch (e) {
      setResult({
        success: false,
        error: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <FileUp className="h-4 w-4 text-muted-foreground" />
          Upload Amazon Report
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
            dragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <Upload className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">
            {selectedFile ? selectedFile.name : "Drop your Amazon report here"}
          </p>
          {selectedFile ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {(selectedFile.size / 1024).toFixed(0)} KB ready to upload
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Inventory Event Detail or Custom Combined Tax Report (CSV/TXT)
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              Browse Files
            </Button>
            {selectedFile && (
              <Button
                size="sm"
                onClick={handleUpload}
                disabled={uploading}
              >
                {uploading ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Upload & Process
                  </>
                )}
              </Button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.tsv"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {uploading && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Processing...</span>
              <span className="font-medium">{progress}%</span>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {result && (
          <div
            className={`rounded-lg border p-4 ${
              result.success
                ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950"
                : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
            }`}
          >
            <div className="flex items-start gap-2">
              {result.success ? (
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              )}
              <div className="space-y-1.5">
                <p
                  className={`text-sm font-medium ${
                    result.success
                      ? "text-emerald-800 dark:text-emerald-300"
                      : "text-red-800 dark:text-red-300"
                  }`}
                >
                  {result.success
                    ? `Successfully processed ${result.filename}`
                    : result.error ?? "Upload failed"}
                </p>
                {result.success && (
                  <div
                    className={`grid gap-x-6 gap-y-0.5 text-xs ${
                      result.success
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-red-700 dark:text-red-400"
                    }`}
                    style={{ gridTemplateColumns: "auto 1fr" }}
                  >
                    <span>Rows total:</span>
                    <span className="font-medium">
                      {result.rows_total?.toLocaleString()}
                    </span>
                    <span>Rows parsed:</span>
                    <span className="font-medium">
                      {result.rows_parsed?.toLocaleString()}
                    </span>
                    <span>Rows inserted:</span>
                    <span className="font-medium">
                      {result.rows_inserted?.toLocaleString()}
                    </span>
                    {(result.rows_skipped ?? 0) > 0 && (
                      <>
                        <span>Rows skipped:</span>
                        <span className="font-medium">
                          {result.rows_skipped?.toLocaleString()}
                        </span>
                      </>
                    )}
                    <span>States found:</span>
                    <span className="font-medium">
                      {result.states_found?.join(", ") || "None"}
                    </span>
                    {result.report_type === "amazon_tax_report" && (
                      <>
                        <span>Unique orders:</span>
                        <span className="font-medium">
                          {result.unique_orders?.toLocaleString()}
                        </span>
                        <span>Gross sales:</span>
                        <span className="font-medium">
                          ${result.total_gross_sales?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                        <span>Tax collected:</span>
                        <span className="font-medium">
                          ${result.total_tax_collected?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                        {(result.ship_from_states?.length ?? 0) > 0 && (
                          <>
                            <span>Ship-from states:</span>
                            <span className="font-medium">
                              {result.ship_from_states?.join(", ")}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
                {(result.unknown_fcs?.length ?? 0) > 0 && (
                  <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      Unknown FC codes: {result.unknown_fcs?.join(", ")}. Add
                      them to config/fc_codes.json.
                    </span>
                  </div>
                )}
                {(result.warnings?.length ?? 0) > 0 &&
                  !result.success && (
                    <ul className="text-xs text-red-700 dark:text-red-400 space-y-0.5">
                      {result.warnings?.slice(0, 5).map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
              </div>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Supported: Amazon Inventory Event Detail, Custom Combined Tax Reports.
          Report type is auto-detected from headers. Maximum file size: 200 MB.
        </p>
      </CardContent>
    </Card>
  );
}

// ── CPA Exports Card ──────────────────────────────────────

interface ExportMeta {
  available: boolean;
  generated_at?: string;
  state_count?: number;
  total_events?: number;
  data_as_of?: string;
  validation?: { check: string; status: string; details: string }[];
  error?: string;
  hint?: string;
  supabase_error?: string;
  bucket?: string;
  key?: string;
}

function CPAExportsCard() {
  const [meta, setMeta] = useState<ExportMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenMsg, setRegenMsg] = useState<string | null>(null);

  function fetchMeta() {
    setLoading(true);
    fetch("/api/exports/inventory-presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((d) => {
        setMeta(d);
        setLoading(false);
      })
      .catch(() => {
        setMeta({ available: false, error: "Failed to reach API" });
        setLoading(false);
      });
  }

  useEffect(() => {
    fetchMeta();
  }, []);

  async function handleDownload(format: string) {
    setDownloading(format);
    try {
      const res = await fetch(
        `/api/exports/inventory-presence?format=${format}`,
      );
      if (!res.ok) {
        const err = await res.json();
        alert(err.hint ?? err.error ?? "Download failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ??
        `inventory_presence.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(null);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setRegenMsg(null);
    try {
      const res = await fetch("/api/exports/inventory-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate" }),
      });
      const d = await res.json();
      if (d.ok) {
        setRegenMsg("Export job enqueued. Waiting for agent...");
        // Poll meta for updates (up to 2 min)
        let attempts = 0;
        const origTime = meta?.generated_at ?? "";
        const poll = setInterval(async () => {
          attempts++;
          try {
            const r2 = await fetch("/api/exports/inventory-presence", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            const m2 = await r2.json();
            if (m2.available && m2.generated_at !== origTime) {
              clearInterval(poll);
              setMeta(m2);
              setRegenerating(false);
              setRegenMsg("Export updated!");
              setTimeout(() => setRegenMsg(null), 3000);
            }
          } catch { /* ignore */ }
          if (attempts >= 24) {
            clearInterval(poll);
            setRegenerating(false);
            setRegenMsg("Timed out waiting. Agent may process it shortly.");
          }
        }, 5000);
      } else {
        setRegenMsg(d.hint ?? d.error ?? "Failed to enqueue job");
        setRegenerating(false);
      }
    } catch (e) {
      setRegenMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setRegenerating(false);
    }
  }

  const hasWarnings = meta?.validation?.some((v) => v.status !== "PASS");

  // Stale check: >36 hours since last export
  const isStale =
    meta?.available && meta.generated_at
      ? Date.now() - new Date(meta.generated_at).getTime() > 36 * 60 * 60 * 1000
      : false;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-muted-foreground" />
          CPA Exports — FBA Inventory Presence
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Disclaimer />

        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <span>
            Amazon Custom Combined Tax CSV data is <strong>quarantined</strong> from nexus
            and liability calculations. SP-API (amazon_spapi) is the authoritative Amazon source.
            Legacy CSV rows remain in the database for audit reference only.
          </span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking export status...
          </div>
        ) : meta?.available ? (
          <>
            {/* Stale banner */}
            {isStale && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="text-xs text-amber-800 dark:text-amber-300">
                  Agent may be offline — last export{" "}
                  {meta.generated_at
                    ? timeAgo(meta.generated_at)
                    : "unknown"}
                </span>
              </div>
            )}

            {/* Status row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border bg-muted/30 p-2.5">
                <p className="text-[11px] text-muted-foreground">Generated</p>
                <p className="text-sm font-medium">
                  {meta.generated_at
                    ? timeAgo(meta.generated_at)
                    : "—"}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2.5">
                <p className="text-[11px] text-muted-foreground">States</p>
                <p className="text-sm font-medium">{meta.state_count ?? "—"}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2.5">
                <p className="text-[11px] text-muted-foreground">Events</p>
                <p className="text-sm font-medium">
                  {meta.total_events?.toLocaleString() ?? "—"}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-2.5">
                <p className="text-[11px] text-muted-foreground">Data as-of</p>
                <p className="text-sm font-medium">{meta.data_as_of ?? "—"}</p>
              </div>
            </div>

            {/* Validation checks */}
            {meta.validation && meta.validation.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Validation Checks
                  {hasWarnings && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">
                      — warnings present
                    </span>
                  )}
                </p>
                <div className="grid gap-1">
                  {meta.validation.map((v) => (
                    <div
                      key={v.check}
                      className="flex items-start gap-2 text-xs"
                    >
                      {v.status === "PASS" ? (
                        <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                      )}
                      <span>
                        <span className="font-medium">{v.check}</span>:{" "}
                        <span className="text-muted-foreground">
                          {v.details.length > 100
                            ? v.details.slice(0, 100) + "..."
                            : v.details}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Download + Refresh buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => handleDownload("pdf")}
                disabled={!!downloading}
              >
                {downloading === "pdf" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                )}
                Download PDF
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleDownload("csv")}
                disabled={!!downloading}
              >
                {downloading === "csv" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
                )}
                Download CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleDownload("md")}
                disabled={!!downloading}
              >
                {downloading === "md" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                )}
                Download Markdown
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRegenerate}
                disabled={regenerating}
              >
                {regenerating ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Refresh Now
              </Button>
            </div>
            {regenMsg && (
              <p className="text-xs text-muted-foreground">{regenMsg}</p>
            )}
          </>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  {meta?.error ?? "No export available"}
                </p>
                {meta?.hint && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {meta.hint}
                  </p>
                )}
                {meta?.supabase_error && (
                  <p className="text-[11px] font-mono text-amber-600 dark:text-amber-500">
                    Supabase: {meta.supabase_error}
                  </p>
                )}
                {meta?.bucket && meta?.key && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-500">
                    Looked for: {meta.bucket}/{meta.key}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SPAPIRefreshCard({ onComplete }: { onComplete: () => void }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setLoading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/spapi-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(data.message);
        onComplete();
      } else {
        setError(data.error ?? "Unknown error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          Amazon SP-API Refresh
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Pull the latest orders and inventory data directly from Amazon&apos;s
          Selling Partner API. Requires SP-API credentials in .env.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Requesting...
            </>
          ) : (
            <>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh Last 30 Days
            </>
          )}
        </Button>
        {message && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
            <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <p className="text-xs text-emerald-800 dark:text-emerald-300">
              {message}
            </p>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            <p className="text-xs text-red-800 dark:text-red-300">{error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DataPage() {
  const {
    data: logs,
    loading: l1,
    refetch: refetchLogs,
  } = useSupabaseQuery<IngestionLog>("ingestion_log", {
    orderBy: "ingested_at",
    limit: 20,
  });
  const { data: tasks, loading: l2 } = useSupabaseQuery<ResearchTask>(
    "research_tasks",
    { orderBy: "created_at" }
  );

  if (l1 || l2) return <LoadingState />;

  const openTasks = tasks.filter(
    (t) => t.status === "open" || t.status === "in_progress"
  );

  const amazonLogs = logs.filter((l) => l.file_type.startsWith("amazon"));
  const shopifyLogs = logs.filter((l) => l.file_type.startsWith("shopify"));
  const lastAmazon = amazonLogs[0];
  const lastShopify = shopifyLogs[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Data & Ingestion
        </h1>
        <p className="text-sm text-muted-foreground">
          Upload data, view ingestion history, and manage research tasks
        </p>
      </div>

      <FileUploadCard onComplete={refetchLogs} />

      <AdsMonthlyUpload onComplete={refetchLogs} />

      <WarehouseBackupCard onComplete={refetchLogs} />

      <SPAPIRefreshCard onComplete={refetchLogs} />

      <CPAExportsCard />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Upload className="h-4 w-4 text-muted-foreground" />
              Amazon FBA Data
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lastAmazon ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {lastAmazon.status === "success" ? (
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm font-medium capitalize">
                    {lastAmazon.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(lastAmazon.ingested_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  File: {lastAmazon.filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {lastAmazon.rows_total} rows processed,{" "}
                  {lastAmazon.rows_inserted} inserted
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Amazon data ingested yet. Use the upload form above or drop a
                CSV into{" "}
                <code className="rounded bg-muted px-1 text-xs">
                  incoming/amazon/
                </code>
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              Shopify Data
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lastShopify ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {lastShopify.status === "success" ? (
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm font-medium capitalize">
                    {lastShopify.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(lastShopify.ingested_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {lastShopify.rows_total} orders,{" "}
                  {lastShopify.rows_inserted} aggregated
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Shopify data yet. Configure API keys or drop a CSV into{" "}
                <code className="rounded bg-muted px-1 text-xs">
                  incoming/shopify/
                </code>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            Alternative: Drop Files (Power Users)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Amazon Reports</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Drop CSV/TXT/XLSX into{" "}
                <code className="rounded bg-muted px-1">incoming/amazon/</code>
                {" "}(SKU Economics monthly, Ads Console, All Orders, or Inventory).
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Shopify Orders</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Automatic via API polling (if configured), or export orders CSV
                and drop into{" "}
                <code className="rounded bg-muted px-1">incoming/shopify/</code>
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Rulings & Documents</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Drop JSON, PDF, or HTML files into{" "}
                <code className="rounded bg-muted px-1">incoming/rulings/</code>{" "}
                for processing
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {openTasks.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              Open Research Tasks ({openTasks.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Priority</TableHead>
                    <TableHead className="w-16">State</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead className="w-20">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openTasks.slice(0, 15).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-xs ${priorityStyles[t.priority] ?? ""}`}
                        >
                          {t.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-medium">
                        {t.state_code ?? "\u2014"}
                      </TableCell>
                      <TableCell className="max-w-sm truncate text-sm">
                        {t.title}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs capitalize">
                          {t.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {logs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4 text-muted-foreground" />
              Ingestion History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead className="w-20">Rows</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-sm font-medium">
                        {fileTypeLabel(l.file_type)}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                        {l.filename}
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.rows_inserted}
                      </TableCell>
                      <TableCell>
                        {l.status === "success" ? (
                          <CheckCircle className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(l.ingested_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
