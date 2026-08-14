"use client";

import { useSupabaseQuery } from "@/lib/hooks";
import type { IngestionLog, ResearchTask } from "@/lib/types";
import { SeverityBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function DataPage() {
  const { data: logs, loading: l1 } = useSupabaseQuery<IngestionLog>(
    "ingestion_log",
    { orderBy: "created_at", limit: 20 }
  );
  const { data: tasks, loading: l2 } = useSupabaseQuery<ResearchTask>(
    "research_tasks",
    { orderBy: "created_at" }
  );

  if (l1 || l2) return <LoadingState />;

  const openTasks = tasks.filter((t) => t.status === "open" || t.status === "in_progress");

  const amazonLogs = logs.filter((l) => l.source === "amazon");
  const shopifyLogs = logs.filter((l) => l.source === "shopify");
  const lastAmazon = amazonLogs[0];
  const lastShopify = shopifyLogs[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Data & Ingestion</h1>
        <p className="text-sm text-muted-foreground">
          Data sources, ingestion history, and research tasks
        </p>
      </div>

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
                  <span className="text-sm font-medium capitalize">{lastAmazon.status}</span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(lastAmazon.created_at)}
                  </span>
                </div>
                {lastAmazon.filename && (
                  <p className="text-xs text-muted-foreground">
                    File: {lastAmazon.filename}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {lastAmazon.rows_processed ?? 0} rows processed,{" "}
                  {lastAmazon.rows_inserted ?? 0} inserted
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Amazon data ingested yet. Drop a CSV into{" "}
                <code className="rounded bg-muted px-1 text-xs">incoming/amazon/</code>
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
                  <span className="text-sm font-medium capitalize">{lastShopify.status}</span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(lastShopify.created_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {lastShopify.rows_processed ?? 0} orders,{" "}
                  {lastShopify.rows_inserted ?? 0} aggregated
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Shopify data yet. Configure API keys or drop a CSV into{" "}
                <code className="rounded bg-muted px-1 text-xs">incoming/shopify/</code>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            How to Add Data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Amazon Reports</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Download Inventory Event Detail from Seller Central and drop the
                CSV/TXT into <code className="rounded bg-muted px-1">incoming/amazon/</code>
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Shopify Orders</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Automatic via API polling (if configured), or export orders CSV
                and drop into <code className="rounded bg-muted px-1">incoming/shopify/</code>
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Rulings & Documents</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Drop JSON, PDF, or HTML files into{" "}
                <code className="rounded bg-muted px-1">incoming/rulings/</code> for
                processing
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
                        {t.state_code ?? "—"}
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
                      <TableCell className="text-sm font-medium capitalize">
                        {l.source}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                        {l.filename ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.rows_inserted ?? l.rows_processed ?? "—"}
                      </TableCell>
                      <TableCell>
                        {l.status === "success" ? (
                          <CheckCircle className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {timeAgo(l.created_at)}
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
