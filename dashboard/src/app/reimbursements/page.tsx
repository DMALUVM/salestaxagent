"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Shield, Wallet } from "lucide-react";
import { ReimbursementsEligiblePanel } from "@/components/reimbursements-eligible";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { amazonAsOf } from "@/lib/as-of";
import {
  REASON_GROUP_LABELS,
  defaultDeskRange,
  filterByGroup,
  qtyUnits,
  reasonGroup,
  reasonLabel,
  rowAmount,
  rowLaDay,
  searchRows,
  sortRows,
  summarizeDesk,
  type DeskSortKey,
  type ReasonFilter,
  type ReimbursementDeskRow,
} from "@/lib/reimbursements-desk";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
function moneyClass(n: number) {
  if (n < 0) return "text-red-500";
  if (n > 0) return "text-emerald-600";
  return "";
}

const FILTERS: { id: ReasonFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "warehouse_damage", label: REASON_GROUP_LABELS.warehouse_damage },
  { id: "lost_inbound", label: REASON_GROUP_LABELS.lost_inbound },
  { id: "lost_warehouse", label: REASON_GROUP_LABELS.lost_warehouse },
  { id: "other", label: REASON_GROUP_LABELS.other },
];

interface DeskPayload {
  asOf: string;
  start: string;
  end: string;
  alertStart: string;
  nightlyDays: number;
  rows: ReimbursementDeskRow[];
  alertRows: ReimbursementDeskRow[];
}

type DeskTab = "paid" | "eligible";

function initialTab(): DeskTab {
  if (typeof window === "undefined") return "paid";
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "eligible" ? "eligible" : "paid";
}

export default function ReimbursementsDeskPage() {
  const defaults = defaultDeskRange();
  const [tab, setTab] = useState<DeskTab>("paid");
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [data, setData] = useState<DeskPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ReasonFilter>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<DeskSortKey>("approval_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function load(rangeStart = start, rangeEnd = end) {
    setLoading(true);
    const params = new URLSearchParams({ start: rangeStart, end: rangeEnd });
    fetch(`/api/reimbursements?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    setTab(initialTab());
    if (!isConfigured()) {
      setLoading(false);
      return;
    }
    load();
    // Default 90d load on mount only; date Apply refetches explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTab(next: DeskTab) {
    setTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "eligible") url.searchParams.set("tab", "eligible");
      else url.searchParams.delete("tab");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
  }

  const rows = data?.rows ?? [];
  const summary = useMemo(() => summarizeDesk(rows), [rows]);
  const visible = useMemo(
    () => sortRows(searchRows(filterByGroup(rows, filter), query), sortKey, sortDir),
    [rows, filter, query, sortKey, sortDir],
  );
  const filterCounts = useMemo(() => ({
    all: rows.length,
    warehouse_damage: filterByGroup(rows, "warehouse_damage").length,
    lost_inbound: filterByGroup(rows, "lost_inbound").length,
    lost_warehouse: filterByGroup(rows, "lost_warehouse").length,
    other: filterByGroup(rows, "other").length,
  }), [rows]);

  const alertRows = data?.alertRows ?? [];
  const alertSummary = useMemo(() => summarizeDesk(alertRows), [alertRows]);
  const maxReasonUnits = Math.max(...summary.byReason.map((r) => Math.abs(r.units)), 1);

  function toggleSort(key: DeskSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "approval_date" || key === "amount_total" || key === "qty_total" ? "desc" : "asc");
  }

  function resetNinety() {
    const range = defaultDeskRange();
    setStart(range.start);
    setEnd(range.end);
    load(range.start, range.end);
  }

  if (!isConfigured()) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">FBA Reimbursements</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "eligible"
              ? "Needs case — inferred open discrepancies, not paid cash"
              : "Paid Amazon FBA reimbursements — cash Amazon already approved"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/amazon">
            <Button variant="outline" size="sm">← Amazon Ops</Button>
          </Link>
          {tab === "paid" && (
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncMsg(null);
              try {
                const r = await fetch("/api/reimbursements/sync", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ days: 90 }),
                });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || "Sync failed");
                setSyncMsg(j.message || "Sync enqueued");
              } catch (e) {
                setSyncMsg(e instanceof Error ? e.message : String(e));
              } finally {
                setSyncing(false);
              }
            }}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            Sync
          </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        <button
          type="button"
          onClick={() => selectTab("paid")}
          className={`border-b-2 px-3 py-2 text-sm transition-colors ${
            tab === "paid"
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Already reimbursed
        </button>
        <button
          type="button"
          onClick={() => selectTab("eligible")}
          className={`border-b-2 px-3 py-2 text-sm transition-colors ${
            tab === "eligible"
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Needs case
        </button>
      </div>

      {tab === "eligible" ? (
        <ReimbursementsEligiblePanel />
      ) : (
      <>

      {syncMsg && <p className="text-xs text-muted-foreground">{syncMsg}</p>}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="space-y-1 text-xs text-muted-foreground">
          From (LA)
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To (LA)
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" />
        </label>
        <Button size="sm" variant="outline" onClick={() => load(start, end)}>Apply</Button>
        <Button size="sm" variant="ghost" onClick={resetNinety}>Last 90 days</Button>
        <p className="text-xs text-muted-foreground sm:ml-auto">
          {fmtDay(start)} – {fmtDay(end)} · Amazon {amazonAsOf() === end ? "closed through yesterday" : "calendar"}
        </p>
      </div>

      {loading && !data ? (
        <LoadingState />
      ) : !rows.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Wallet className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No paid reimbursements in this window.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nightly sync already covers 90 closed LA days. Or run:{" "}
              <code>python -m src.main spapi-reimbursements --days 90</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {alertRows.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  {alertRows.length} new warehouse / inbound reimbursement
                  {alertRows.length === 1 ? "" : "s"} in the last 7 closed LA days
                  {data?.alertStart ? ` (${fmtDay(data.alertStart)} – ${fmtDay(data.asOf)})` : ""}
                </p>
                <p className="text-xs opacity-80">
                  Warehouse damage {fmt(alertSummary.groups.warehouse_damage.units)} u · Lost inbound{" "}
                  {fmt(alertSummary.groups.lost_inbound.units)} u · Lost warehouse{" "}
                  {fmt(alertSummary.groups.lost_warehouse.units)} u
                  {" "}(${fmtD(alertSummary.overview.amount)}). Case prep is Reese’s lane — Dave submits.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Overview</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.overview.units)}</p>
                <p className={`text-xs tabular-nums ${moneyClass(summary.overview.amount)}`}>
                  ${fmtD(summary.overview.amount)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Warehouse damage</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.warehouse_damage.units)}</p>
                <p className={`text-xs tabular-nums ${moneyClass(summary.groups.warehouse_damage.amount)}`}>
                  ${fmtD(summary.groups.warehouse_damage.amount)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Lost inbound</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.lost_inbound.units)}</p>
                <p className={`text-xs tabular-nums ${moneyClass(summary.groups.lost_inbound.amount)}`}>
                  ${fmtD(summary.groups.lost_inbound.amount)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Lost warehouse</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.lost_warehouse.units)}</p>
                <p className={`text-xs tabular-nums ${moneyClass(summary.groups.lost_warehouse.amount)}`}>
                  ${fmtD(summary.groups.lost_warehouse.amount)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Resolved · cash reimbursed</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.resolved.cashUnits)}</p>
                <p className={`text-xs tabular-nums ${moneyClass(summary.resolved.amount)}`}>
                  ${fmtD(summary.resolved.amount)}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap gap-1 border-b">
            {FILTERS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                  filter === tab.id
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
                <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                  ({filterCounts[tab.id]})
                </span>
              </button>
            ))}
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Reason types</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {summary.byReason.map((r) => {
                  const pct = maxReasonUnits > 0 ? (Math.abs(r.units) / maxReasonUnits) * 100 : 0;
                  return (
                    <div key={r.reason} className="flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${
                            r.group === "other" ? "bg-slate-400" : "bg-blue-600"
                          }`}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <span className="w-40 truncate text-xs">{r.label}</span>
                      <span className="w-12 text-right text-xs tabular-nums font-medium">{fmt(r.units)}</span>
                      <span className={`w-20 text-right text-xs tabular-nums ${moneyClass(r.amount)}`}>
                        ${fmtD(r.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-sm font-medium">
                  Approvals ({fmt(visible.length)})
                </CardTitle>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search SKU, ASIN, reason, reimbursement ID"
                  className="max-w-sm"
                />
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Date" active={sortKey === "approval_date"} dir={sortDir} onClick={() => toggleSort("approval_date")} />
                    <SortHead label="Reason" active={sortKey === "reason"} dir={sortDir} onClick={() => toggleSort("reason")} />
                    <SortHead label="SKU / ASIN" active={sortKey === "sku"} dir={sortDir} onClick={() => toggleSort("sku")} />
                    <SortHead label="Qty" active={sortKey === "qty_total"} dir={sortDir} onClick={() => toggleSort("qty_total")} align="right" />
                    <SortHead label="Amount" active={sortKey === "amount_total"} dir={sortDir} onClick={() => toggleSort("amount_total")} align="right" />
                    <SortHead label="Reimbursement ID" active={sortKey === "reimbursement_id"} dir={sortDir} onClick={() => toggleSort("reimbursement_id")} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => {
                    const day = rowLaDay(r) ?? r.approval_date.slice(0, 10);
                    const amt = rowAmount(r);
                    const alert = reasonGroup(r.reason) !== "other";
                    return (
                      <TableRow key={`${r.reimbursement_id}:${r.sku ?? ""}:${day}`}>
                        <TableCell className="text-xs tabular-nums">{day}</TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium">{reasonLabel(r.reason)}</span>
                          {alert && (
                            <Badge variant="outline" className="ml-1.5 text-[9px] font-normal">
                              watch
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.sku || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{r.asin || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(qtyUnits(r))}</TableCell>
                        <TableCell className={`text-right tabular-nums ${moneyClass(amt)}`}>
                          ${fmtD(amt)}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {r.reimbursement_id}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Cash awareness only — not folded into contribution or net after ads.
        Nightly GET_FBA_REIMBURSEMENTS_DATA already covers 90 closed LA days (chunked ≤30).
        This desk is observe/alert; case prep is Reese’s lane and Dave submits. It does not auto-file Amazon cases.
        Open / eligible cases live on the Needs case tab (GET_LEDGER_DETAIL_VIEW_DATA Adjustments + inbound shorts).
      </p>
      </>
      )}
    </div>
  );
}

function SortHead({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "right";
}) {
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          align === "right" ? "w-full justify-end" : ""
        } ${active ? "text-foreground" : ""}`}
      >
        {label}
        {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </TableHead>
  );
}
