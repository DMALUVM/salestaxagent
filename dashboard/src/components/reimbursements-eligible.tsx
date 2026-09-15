"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCopy, ExternalLink, RefreshCw, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { amazonAsOf } from "@/lib/as-of";
import {
  CASE_QUEUE_GAP,
  CASE_QUEUE_SOURCES,
  REASON_GROUP_LABELS,
  REESE_AGENT_NAME,
  SELLER_CENTRAL_LINK_LIMIT,
  caseAmount,
  caseDay,
  caseQty,
  defaultCaseRange,
  filterCaseGroup,
  linkKindLabel,
  reasonLabel,
  searchCaseRows,
  sellerCentralHref,
  sortCaseRows,
  summarizeCases,
  type CaseEventRow,
  type CaseSortKey,
  type ReasonFilter,
} from "@/lib/reimbursements-eligible";

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

const FILTERS: { id: ReasonFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "warehouse_damage", label: REASON_GROUP_LABELS.warehouse_damage },
  { id: "lost_inbound", label: REASON_GROUP_LABELS.lost_inbound },
  { id: "lost_warehouse", label: REASON_GROUP_LABELS.lost_warehouse },
];

interface EligiblePayload {
  asOf: string;
  start: string;
  end: string;
  alertStart: string;
  nightlyDays: number;
  tableMissing?: boolean;
  gap?: string;
  sources?: string[];
  sellerCentralLinkLimit?: string;
  syncedAt?: string | null;
  rows: CaseEventRow[];
  alertRows: CaseEventRow[];
}

export function ReimbursementsEligiblePanel() {
  const defaults = defaultCaseRange();
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [data, setData] = useState<EligiblePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ReasonFilter>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<CaseSortKey>("event_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [syncing, setSyncing] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function load(rangeStart = start, rangeEnd = end) {
    setLoading(true);
    const params = new URLSearchParams({ start: rangeStart, end: rangeEnd });
    fetch(`/api/reimbursements/eligible?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Default 90d load on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data?.rows ?? [];
  const summary = useMemo(() => summarizeCases(rows), [rows]);
  const visible = useMemo(
    () => sortCaseRows(searchCaseRows(filterCaseGroup(rows, filter), query), sortKey, sortDir),
    [rows, filter, query, sortKey, sortDir],
  );
  const filterCounts = useMemo(() => ({
    all: rows.length,
    warehouse_damage: filterCaseGroup(rows, "warehouse_damage").length,
    lost_inbound: filterCaseGroup(rows, "lost_inbound").length,
    lost_warehouse: filterCaseGroup(rows, "lost_warehouse").length,
    other: filterCaseGroup(rows, "other").length,
  }), [rows]);
  const alertRows = data?.alertRows ?? [];
  const alertSummary = useMemo(() => summarizeCases(alertRows), [alertRows]);

  function toggleSort(key: CaseSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "event_date" || key === "estimated_amount" || key === "quantity" ? "desc" : "asc");
  }

  function resetNinety() {
    const range = defaultCaseRange();
    setStart(range.start);
    setEnd(range.end);
    load(range.start, range.end);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Needs case</h2>
          <p className="text-sm text-muted-foreground">
            Open / case-eligible FBA discrepancies — not yet reimbursed
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setMsg(null);
              try {
                const r = await fetch("/api/reimbursements/eligible/sync", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ days: 90 }),
                });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || "Sync failed");
                setMsg(j.message || "Sync enqueued");
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              } finally {
                setSyncing(false);
              }
            }}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            Sync queue
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={notifying || !rows.length}
            onClick={async () => {
              setNotifying(true);
              setMsg(null);
              setCopied(false);
              try {
                const r = await fetch("/api/reimbursements/eligible/notify", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ start, end, source: "dashboard" }),
                });
                const j = await r.json();
                if (!r.ok) throw new Error(j.error || "Notify failed");
                if (j.markdown && navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(j.markdown);
                  setCopied(true);
                }
                setMsg(
                  `Prep package for ${REESE_AGENT_NAME}`
                  + (j.package_id ? ` · stored ${j.package_id}` : "")
                  + (j.markdown ? " · markdown copied" : "")
                  + ". Forward to Reese — Dave submits. No auto-file.",
                );
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              } finally {
                setNotifying(false);
              }
            }}
          >
            {copied ? (
              <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Send className="mr-1.5 h-3.5 w-3.5" />
            )}
            Prep for Reese
          </Button>
        </div>
      </div>

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground space-y-1">
        <p>{data?.gap || CASE_QUEUE_GAP}</p>
        <p>
          Sources: {(data?.sources ?? [...CASE_QUEUE_SOURCES]).join(" · ")}. Dana owns tab + sync;
          Reese preps; Dave submits. This desk does not auto-file Amazon cases.
        </p>
        <p>{data?.sellerCentralLinkLimit || SELLER_CENTRAL_LINK_LIMIT}</p>
      </div>

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
          {data?.syncedAt ? ` · queue synced ${data.syncedAt.slice(0, 16).replace("T", " ")} UTC` : ""}
        </p>
      </div>

      {loading && !data ? (
        <LoadingState />
      ) : data?.tableMissing ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Warehouse table <code>fba_case_events</code> is not applied yet.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Apply <code>supabase/migration_fba_case_queue.sql</code> then{" "}
              <code>python -m src.main reimbursements-case-sync --days 90</code>
            </p>
          </CardContent>
        </Card>
      ) : !rows.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">No open Needs-case rows in this window.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nightly Mini rebuilds the queue after paid reimbursements. Or Sync queue /
              <code> python -m src.main reimbursements-case-sync --days 90</code>
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
                  {alertRows.length} Needs-case event{alertRows.length === 1 ? "" : "s"} in the last 7 closed LA days
                  {data?.alertStart ? ` (${fmtDay(data.alertStart)} – ${fmtDay(data.asOf)})` : ""}
                </p>
                <p className="text-xs opacity-80">
                  Warehouse damage {fmt(alertSummary.groups.warehouse_damage.units)} u · Lost inbound{" "}
                  {fmt(alertSummary.groups.lost_inbound.units)} u · Lost warehouse{" "}
                  {fmt(alertSummary.groups.lost_warehouse.units)} u
                  {alertSummary.estimatedKnown ? ` · ~$${fmtD(alertSummary.estimated)}` : ""}.
                  {" "}Prep is Reese’s lane — Dave submits.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Needs case</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.units)}</p>
                <p className="text-xs text-muted-foreground">{fmt(summary.events)} events</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Warehouse damage</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.warehouse_damage.units)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Lost inbound</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.lost_inbound.units)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Lost warehouse</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(summary.groups.lost_warehouse.units)}</p>
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
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-sm font-medium">
                  Open cases ({fmt(visible.length)})
                </CardTitle>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search SKU, ASIN, shipment, reason"
                  className="max-w-sm"
                />
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Date" active={sortKey === "event_date"} dir={sortDir} onClick={() => toggleSort("event_date")} />
                    <SortHead label="Reason" active={sortKey === "reason"} dir={sortDir} onClick={() => toggleSort("reason")} />
                    <SortHead label="SKU / ASIN" active={sortKey === "sku"} dir={sortDir} onClick={() => toggleSort("sku")} />
                    <SortHead label="Qty" active={sortKey === "quantity"} dir={sortDir} onClick={() => toggleSort("quantity")} align="right" />
                    <SortHead label="Est $" active={sortKey === "estimated_amount"} dir={sortDir} onClick={() => toggleSort("estimated_amount")} align="right" />
                    <TableHead>FC / Shipment</TableHead>
                    <TableHead>Seller Central</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => {
                    const day = caseDay(r);
                    const amt = r.estimated_amount;
                    const href = sellerCentralHref(r);
                    return (
                      <TableRow key={r.event_key}>
                        <TableCell className="text-xs tabular-nums">{day}</TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium">{reasonLabel(r.reason)}</span>
                          <div className="text-[10px] text-muted-foreground">
                            {r.source === "inbound_discrepancy" ? "Inbound short" : "Ledger adjustment"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.sku || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{r.asin || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(caseQty(r))}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {amt == null || amt === "" ? "—" : `$${fmtD(caseAmount(r))}`}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{r.fulfillment_center || "—"}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {r.shipment_id || r.reference_id || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {linkKindLabel(r.seller_central_link_kind)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-normal">
                            Needs case
                          </Badge>
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
