"use client";

import { useEffect, useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, SalesByState } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertTriangle, CheckCircle, Download, FileSpreadsheet, FileText,
  Loader2, RefreshCw, Search, TrendingUp,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────

interface StateAudit {
  state_code: string;
  state_name: string;
  window_start: string;
  window_end: string;
  measurement_period: string;
  shopify_sales: number;
  shopify_orders: number;
  amazon_sales: number;
  amazon_orders: number;
  marketplace_sales_included: boolean;
  marketplace_rule_confidence: string;
  counted_sales: number;
  counted_orders: number;
  threshold_amount: number;
  threshold_transactions: number | null;
  threshold_test_type: string;
  pct_of_dollar_threshold: number;
  pct_of_txn_threshold: number;
  status: string;
  is_registered: boolean;
  formula: string;
  data_coverage: {
    shopify_min_date: string | null;
    shopify_max_date: string | null;
    amazon_min_date: string | null;
    amazon_max_date: string | null;
    gaps: string[];
  };
  monthly_breakdown: Array<{
    month: string;
    shopify: number;
    amazon: number;
    shopify_txn: number;
    amazon_txn: number;
  }>;
}

interface AuditMeta {
  available: boolean;
  generated_at?: string;
  states_analyzed?: number;
  exceeded?: string[];
  approaching?: string[];
  validation?: { check: string; status: string; details: string }[];
  data_gaps?: string[];
}

// ── Helpers ────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function statusColor(s: string) {
  if (s === "exceeded") return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  if (s === "approaching") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (s === "caution") return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300";
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
}

function barWidth(pct: number) {
  return `${Math.min(pct, 100)}%`;
}

function barColor(pct: number) {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  if (pct >= 50) return "bg-yellow-500";
  return "bg-emerald-500";
}

// ── Detail drawer ──────────────────────────────────────────

function StateDrawer({
  state,
  onClose,
}: {
  state: StateAudit | null;
  onClose: () => void;
}) {
  if (!state) return null;
  const s = state;
  return (
    <Sheet open={!!state} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {s.state_code} — {s.state_name}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {/* Formula */}
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-1">Formula</p>
            <p className="text-sm font-mono">{s.formula}</p>
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[10px] text-muted-foreground">Window</p>
              <p className="font-medium">{s.window_start} to {s.window_end}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.measurement_period.replace(/_/g, " ")}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Threshold</p>
              <p className="font-medium">${fmt(s.threshold_amount)}{s.threshold_transactions ? ` / ${fmt(s.threshold_transactions)} txns` : ""}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">test: {s.threshold_test_type.toUpperCase()}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">MP counts?</p>
              <p className="font-medium">{s.marketplace_sales_included ? "Yes" : "No"} ({s.marketplace_rule_confidence})</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Status</p>
              <Badge className={`${statusColor(s.status)} text-xs`}>{s.status.toUpperCase()}</Badge>
              {s.is_registered && <Badge variant="outline" className="ml-1 text-[10px]">Registered</Badge>}
            </div>
          </div>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span>Dollar threshold</span>
              <span className="font-medium">{s.pct_of_dollar_threshold.toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${barColor(s.pct_of_dollar_threshold)}`} style={{ width: barWidth(s.pct_of_dollar_threshold) }} />
            </div>
            {s.threshold_transactions && (
              <>
                <div className="flex justify-between text-xs mb-1 mt-2">
                  <span>Transaction threshold</span>
                  <span className="font-medium">{s.pct_of_txn_threshold.toFixed(0)}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className={`h-full rounded-full ${barColor(s.pct_of_txn_threshold)}`} style={{ width: barWidth(s.pct_of_txn_threshold) }} />
                </div>
              </>
            )}
          </div>

          {/* Coverage warnings */}
          {s.data_coverage.gaps.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">Coverage Warnings</p>
              {s.data_coverage.gaps.map((g, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-400">{g}</p>
              ))}
            </div>
          )}

          {/* Monthly breakdown */}
          {s.monthly_breakdown.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Monthly Breakdown</p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Month</TableHead>
                      <TableHead className="text-xs text-right">Shopify $</TableHead>
                      <TableHead className="text-xs text-right">Amazon $</TableHead>
                      <TableHead className="text-xs text-right">Sh Txn</TableHead>
                      <TableHead className="text-xs text-right">Am Txn</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.monthly_breakdown.map((m) => (
                      <TableRow key={m.month}>
                        <TableCell className="text-xs">{m.month}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">${fmt(m.shopify)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">${fmt(m.amazon)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{fmt(m.shopify_txn)}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{fmt(m.amazon_txn)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Data dates */}
          <div className="text-[10px] text-muted-foreground space-y-0.5">
            <p>Shopify data: {s.data_coverage.shopify_min_date ?? "none"} to {s.data_coverage.shopify_max_date ?? "none"}</p>
            <p>Amazon data: {s.data_coverage.amazon_min_date ?? "none"} to {s.data_coverage.amazon_max_date ?? "none"}</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main page ──────────────────────────────────────────────

export default function EconomicNexusAuditPage() {
  const { data: nexusRows, loading: l1 } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: salesRows, loading: l2 } = useSupabaseQuery<SalesByState>("sales_by_state");

  const [meta, setMeta] = useState<AuditMeta | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("needs_reg");
  const [selectedState, setSelectedState] = useState<StateAudit | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  // Load audit data from Storage JSON (full audit with monthly breakdowns)
  const [auditStates, setAuditStates] = useState<StateAudit[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);

  useEffect(() => {
    // Fetch full audit JSON from Storage (via API)
    fetch("/api/exports/economic-nexus?format=json")
      .then(async (r) => {
        if (!r.ok) {
          setAuditLoading(false);
          return;
        }
        const audit = await r.json();
        setAuditStates(audit.states ?? []);
        setAuditLoading(false);
      })
      .catch(() => setAuditLoading(false));

    // Fetch meta
    fetch("/api/exports/economic-nexus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((d) => setMeta(d))
      .catch(() => {});
  }, []);

  // Build audit from live DB if Storage is empty
  const liveAudit = useMemo(() => {
    if (auditStates.length > 0) return auditStates;
    if (l1 || l2 || !nexusRows.length) return [];

    // Build a simplified live audit from nexus_status + sales_by_state
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const salesByState: Record<string, { shopify: number; amazon: number; sh_txn: number; am_txn: number }> = {};
    for (const s of salesRows) {
      const pe = s.period_end ?? "";
      if (pe < cutoffStr) continue;
      const sc = s.state_code;
      if (!salesByState[sc]) salesByState[sc] = { shopify: 0, amazon: 0, sh_txn: 0, am_txn: 0 };
      const ch = normalizeChannel(s.channel ?? "");
      if (ch === SHOPIFY) {
        salesByState[sc].shopify += Number(s.gross_sales) || 0;
        salesByState[sc].sh_txn += Number(s.order_count) || 0;
      } else {
        salesByState[sc].amazon += Number(s.gross_sales) || 0;
        salesByState[sc].am_txn += Number(s.order_count) || 0;
      }
    }

    return nexusRows
      .filter((n) => n.economic_progress_percent != null && (n.economic_progress_percent ?? 0) > 0)
      .map((n): StateAudit => {
        const s = salesByState[n.state_code] ?? { shopify: 0, amazon: 0, sh_txn: 0, am_txn: 0 };
        const pct = n.economic_progress_percent ?? 0;
        const status = pct >= 100 ? "exceeded" : pct >= 80 ? "approaching" : pct >= 50 ? "caution" : "under";
        return {
          state_code: n.state_code,
          state_name: n.state_code,
          window_start: cutoffStr,
          window_end: new Date().toISOString().slice(0, 10),
          measurement_period: "trailing_12_months",
          shopify_sales: s.shopify,
          shopify_orders: s.sh_txn,
          amazon_sales: s.amazon,
          amazon_orders: s.am_txn,
          marketplace_sales_included: true,
          marketplace_rule_confidence: "medium",
          counted_sales: n.economic_progress_amount ?? 0,
          counted_orders: n.economic_progress_transactions ?? 0,
          threshold_amount: 100000,
          threshold_transactions: null,
          threshold_test_type: "or",
          pct_of_dollar_threshold: pct,
          pct_of_txn_threshold: 0,
          status,
          is_registered: n.is_registered,
          formula: "Live estimate — run full audit for precise figures",
          data_coverage: { shopify_min_date: null, shopify_max_date: null, amazon_min_date: null, amazon_max_date: null, gaps: [] },
          monthly_breakdown: [],
        };
      });
  }, [auditStates, nexusRows, salesRows, l1, l2]);

  const states = liveAudit;
  // Registration-aware buckets: default view = unregistered action items.
  // Coerce is_registered to handle any truthy variant from Supabase/JSON.
  const isReg = (s: StateAudit) => s.is_registered === true;
  const needsReg = states.filter((s) => (s.status === "exceeded" || s.status === "approaching") && !isReg(s));
  const approachingUnreg = states.filter((s) => s.status === "approaching" && !isReg(s));
  const registeredStates = states.filter((s) => isReg(s));
  const all = states;

  function applySearch(list: StateAudit[]) {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter((s) => s.state_code.toLowerCase().includes(q) || s.state_name.toLowerCase().includes(q));
  }

  async function handleDownload(format: string) {
    setDownloading(format);
    try {
      const res = await fetch(`/api/exports/economic-nexus?format=${format}`);
      if (!res.ok) { alert("Export not available. Run the audit CLI first."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? `economic_nexus_audit.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { alert("Download failed"); }
    finally { setDownloading(null); }
  }

  if (l1 || l2 || auditLoading) return <LoadingState />;

  function AuditTable({ rows }: { rows: StateAudit[] }) {
    const filtered = applySearch(rows);
    if (filtered.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No states match.</p>;
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">State</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Shopify $</TableHead>
              <TableHead className="text-right">Amazon $</TableHead>
              <TableHead className="text-right">Counted $</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              <TableHead className="w-[80px]">%</TableHead>
              <TableHead className="text-right">Txns</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>MP?</TableHead>
              <TableHead>Conf</TableHead>
              <TableHead>Gaps</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((s) => (
              <TableRow
                key={s.state_code}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setSelectedState(s)}
              >
                <TableCell className="font-medium">
                  {s.state_code}
                  {s.is_registered && <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">Reg</Badge>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.window_start.slice(5)} – {s.window_end.slice(5)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">${fmt(s.shopify_sales)}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">${fmt(s.amazon_sales)}</TableCell>
                <TableCell className="text-right tabular-nums text-xs font-medium">${fmt(s.counted_sales)}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">${fmt(s.threshold_amount)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                      <div className={`h-full rounded-full ${barColor(s.pct_of_dollar_threshold)}`} style={{ width: barWidth(s.pct_of_dollar_threshold) }} />
                    </div>
                    <span className="text-xs tabular-nums">{s.pct_of_dollar_threshold.toFixed(0)}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">{s.counted_orders > 0 ? fmt(s.counted_orders) : "—"}</TableCell>
                <TableCell>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusColor(s.status)}`}>
                    {s.status}
                  </span>
                </TableCell>
                <TableCell className="text-xs">{s.marketplace_sales_included ? "Yes" : "No"}</TableCell>
                <TableCell>
                  <span className={`text-[10px] ${s.marketplace_rule_confidence === "high" ? "text-emerald-600" : "text-amber-600"}`}>
                    {s.marketplace_rule_confidence}
                  </span>
                </TableCell>
                <TableCell>
                  {s.data_coverage.gaps.length > 0 && (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Economic Nexus Audit</h1>
          <p className="text-sm text-muted-foreground">
            Per-state threshold analysis with full sales breakdown, marketplace rules, and data coverage.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => handleDownload("pdf")} disabled={!!downloading}>
            {downloading === "pdf" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
            PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleDownload("csv")} disabled={!!downloading}>
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
            CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleDownload("json")} disabled={!!downloading}>
            <FileText className="mr-1.5 h-3.5 w-3.5" />
            JSON
          </Button>
        </div>
      </div>

      <Disclaimer />

      {/* Validation summary */}
      {meta?.validation && (
        <Card>
          <CardContent className="py-3">
            <div className="flex flex-wrap gap-3">
              {meta.validation.map((v) => (
                <div key={v.check} className="flex items-center gap-1.5 text-xs">
                  {v.status === "PASS" ? <CheckCircle className="h-3 w-3 text-emerald-500" /> : <AlertTriangle className="h-3 w-3 text-amber-500" />}
                  <span className="font-medium">{v.check.split(" — ")[0]}</span>
                </div>
              ))}
              {meta.generated_at && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Generated {new Date(meta.generated_at).toLocaleString()}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <span className="text-2xl font-bold">{needsReg.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">Needs Registration</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-amber-500" />
              <span className="text-2xl font-bold">{approachingUnreg.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">Approaching (unreg)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-blue-500" />
              <span className="text-2xl font-bold">{registeredStates.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">Registered</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <span className="text-2xl font-bold">{all.length}</span>
            <p className="text-xs text-muted-foreground">All analyzed</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Filter states..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
      </div>

      {/* Tabs — default is Needs Registration, not all exceeded */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="needs_reg">Needs Registration ({needsReg.length})</TabsTrigger>
          <TabsTrigger value="registered">Registered ({registeredStates.length})</TabsTrigger>
          <TabsTrigger value="all">All ({all.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="needs_reg" className="mt-4">
          <Card><CardContent className="p-0"><AuditTable rows={needsReg} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="registered" className="mt-4">
          {registeredStates.length > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">
              Registered states shown for CPA audit transparency — no registration action needed.
            </p>
          )}
          <Card><CardContent className="p-0"><AuditTable rows={registeredStates} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="all" className="mt-4">
          <Card><CardContent className="p-0"><AuditTable rows={all} /></CardContent></Card>
        </TabsContent>
      </Tabs>

      {/* Detail drawer */}
      <StateDrawer state={selectedState} onClose={() => setSelectedState(null)} />
    </div>
  );
}
