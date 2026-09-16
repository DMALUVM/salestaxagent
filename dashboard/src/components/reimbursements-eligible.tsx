"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ClipboardCopy, ExternalLink, RefreshCw, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { amazonAsOf } from "@/lib/as-of";
import {
  CASE_QUEUE_GAP,
  CASE_QUEUE_SOURCE_NOTE,
  CASE_QUEUE_SOURCES,
  CLASSIFICATION_VERSION,
  CLEAR_REASON_LABELS,
  CLEAR_REASONS,
  HOW_TO_FILE_INBOUND,
  HOW_TO_FILE_INBOUND_STEPS,
  HOW_TO_FILE_INBOUND_TITLE,
  HOW_TO_FILE_INTRO,
  HOW_TO_FILE_NO_DEEP_LINK,
  HOW_TO_FILE_STEPS,
  HOW_TO_FILE_TITLE,
  IDR_INSTRUCTION,
  KPI_EVENTS_LABEL,
  KPI_UNITS_LABEL,
  MINI_RESYNC_HINT,
  NO_INBOUND_DISCREPANCIES,
  NOTIFY_BLOCK_COPY,
  REASON_GROUP_LABELS,
  REESE_AGENT_NAME,
  SC_ELIGIBLE_FOR_CLAIM,
  SELLER_CENTRAL_LINK_LIMIT,
  apiUrl,
  caseAmount,
  caseDay,
  caseKpi,
  caseQty,
  clearReasonLabel,
  clearResultMessage,
  defaultCaseRange,
  fbaShipmentId,
  filterCaseGroup,
  formatCasePacket,
  inboundDiscrepancyCount,
  inboundReceived,
  inboundShipped,
  isInboundTrackerLink,
  reasonLabel,
  searchCaseRows,
  sellerCentralHref,
  sortCaseRows,
  sourceLabel,
  summarizeCases,
  type CaseEventRow,
  type CaseQa,
  type CaseSortKey,
  type ClearReason,
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
  classificationVersion?: string;
  miniResync?: string;
  qa?: CaseQa;
  syncedAt?: string | null;
  howToInbound?: string;
  rows: CaseEventRow[];
  submittedRows?: CaseEventRow[];
  inboundAlerts?: CaseEventRow[];
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clearReason, setClearReason] = useState<ClearReason>("filed");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function load(rangeStart = start, rangeEnd = end) {
    setLoading(true);
    const params = new URLSearchParams({ start: rangeStart, end: rangeEnd });
    fetch(apiUrl(`/api/reimbursements/eligible?${params}`))
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
  const kpi = useMemo(() => caseKpi(summary), [summary]);
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
  const submittedRows = data?.submittedRows ?? [];
  const alertSummary = useMemo(() => summarizeCases(alertRows), [alertRows]);
  const inboundCount = inboundDiscrepancyCount(rows);

  async function clearRows(keys: string[], reason: ClearReason) {
    if (!keys.length) return;
    setBusyKey(keys.length === 1 ? keys[0] : "bulk");
    setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/reimbursements/inbound-alerts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          keys.length === 1
            ? { event_key: keys[0], reason, note: reason }
            : { event_keys: keys, reason, note: reason },
        ),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Clear failed");
      setMsg(clearResultMessage(reason, keys.length));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.delete(key);
        return next;
      });
      load(start, end);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }
  const qa = data?.qa;
  const qaOk = Boolean(qa?.ok);
  const notifyBlocked = !qaOk || !rows.length;

  async function copyPacket(row: CaseEventRow) {
    const text = formatCasePacket(row);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedKey(row.event_key);
      }
    } catch {
      setCopiedKey(null);
    }
  }

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
                const r = await fetch(apiUrl("/api/reimbursements/eligible/sync"), {
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
            disabled={notifying || notifyBlocked}
            title={notifyBlocked ? NOTIFY_BLOCK_COPY : "Build a verified prep package for Reese"}
            onClick={async () => {
              setNotifying(true);
              setMsg(null);
              setCopied(false);
              try {
                const r = await fetch(apiUrl("/api/reimbursements/eligible/notify"), {
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

      {qa && !qa.ok && (
        <div className="flex items-start gap-2 rounded-lg border border-red-400/70 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Classification / sync QA is not green — do not prep Reese packets</p>
            <p className="text-xs opacity-90">{NOTIFY_BLOCK_COPY}</p>
            <ul className="list-disc pl-4 text-xs opacity-90">
              {(qa.errors ?? []).slice(0, 6).map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
            <p className="text-xs font-mono opacity-80">
              {data?.miniResync || MINI_RESYNC_HINT}
            </p>
            <p className="text-[10px] opacity-70">
              Wanted classification_version {data?.classificationVersion || CLASSIFICATION_VERSION}
            </p>
          </div>
        </div>
      )}
      {qa?.ok && rows.length > 0 && (
        <div className="rounded-lg border border-emerald-400/50 bg-emerald-50 px-3 py-2 text-xs text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
          Classification {qa.classification_version} verified. Notify Reese is unlocked.
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{HOW_TO_FILE_TITLE}</CardTitle>
          <p className="text-xs text-muted-foreground">{HOW_TO_FILE_INTRO}</p>
        </CardHeader>
        <CardContent className="space-y-3 pb-4">
          <ol className="space-y-2 text-sm">
            {HOW_TO_FILE_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-2">
                <span className="mt-0.5 w-5 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                  {i + 1}.
                </span>
                <div>
                  <p className="font-medium leading-snug">{step.title}</p>
                  <p className="text-xs text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            {HOW_TO_FILE_NO_DEEP_LINK}
          </p>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground space-y-1">
        <p>{CASE_QUEUE_SOURCE_NOTE}</p>
        {data && !data.tableMissing && inboundCount === 0 && (
          <p>{NO_INBOUND_DISCREPANCIES}</p>
        )}
        <p>{data?.gap || CASE_QUEUE_GAP}</p>
        <p>
          Sources: {(data?.sources ?? [...CASE_QUEUE_SOURCES]).join(" · ")}. Dana owns tab + sync;
          Reese preps; Dave submits. This desk does not auto-file Amazon cases.
        </p>
        <p>{data?.sellerCentralLinkLimit || SELLER_CENTRAL_LINK_LIMIT}</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{HOW_TO_FILE_INBOUND_TITLE}</CardTitle>
          <p className="text-xs text-muted-foreground">{data?.howToInbound || HOW_TO_FILE_INBOUND}</p>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <ol className="list-decimal space-y-1.5 pl-4">
            {HOW_TO_FILE_INBOUND_STEPS.map((step) => (
              <li key={step.title}>
                <span className="font-medium text-foreground">{step.title}.</span>{" "}
                {step.body}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

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
        <>
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm text-muted-foreground">No open Needs-case rows in this window.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Nightly Mini rebuilds the queue after paid reimbursements. Or Sync queue /
                <code> python -m src.main reimbursements-case-sync --days 90</code>
              </p>
            </CardContent>
          </Card>
          {submittedRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Submitted / cleared ({fmt(submittedRows.length)})
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>SKU / ASIN</TableHead>
                      <TableHead className="text-right">Short</TableHead>
                      <TableHead>Shipment</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {submittedRows.map((r) => (
                      <TableRow key={r.event_key}>
                        <TableCell className="text-xs tabular-nums">{caseDay(r)}</TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.sku || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{r.asin || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(caseQty(r))}</TableCell>
                        <TableCell className="text-xs font-mono">{fbaShipmentId(r.shipment_id) || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{sourceLabel(r.source)}</TableCell>
                        <TableCell className="text-xs">{clearReasonLabel(r)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
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
            <CaseKpiCard
              title="Needs case"
              events={kpi.primary}
              units={kpi.units}
              estimated={kpi.estimated}
              estimatedKnown={kpi.estimatedKnown}
            />
            <CaseKpiCard
              title="Warehouse damage"
              events={summary.groups.warehouse_damage.events}
              units={summary.groups.warehouse_damage.units}
              estimated={summary.groups.warehouse_damage.estimated}
              estimatedKnown={kpi.estimatedKnown && summary.groups.warehouse_damage.estimated !== 0}
            />
            <CaseKpiCard
              title="Lost inbound"
              events={summary.groups.lost_inbound.events}
              units={summary.groups.lost_inbound.units}
              estimated={summary.groups.lost_inbound.estimated}
              estimatedKnown={kpi.estimatedKnown && summary.groups.lost_inbound.estimated !== 0}
            />
            <CaseKpiCard
              title="Lost warehouse"
              events={summary.groups.lost_warehouse.events}
              units={summary.groups.lost_warehouse.units}
              estimated={summary.groups.lost_warehouse.estimated}
              estimatedKnown={kpi.estimatedKnown && summary.groups.lost_warehouse.estimated !== 0}
            />
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
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={clearReason}
                    onChange={(e) => setClearReason(e.target.value as ClearReason)}
                    className="h-8 w-[10.5rem] text-xs"
                    aria-label="Clear reason"
                  >
                    {CLEAR_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {CLEAR_REASON_LABELS[reason]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selected.size || busyKey === "bulk"}
                    onClick={() => clearRows([...selected], clearReason)}
                    title="Clear selected rows. Evidence stays in history. No Amazon write."
                  >
                    <Check className="mr-1 h-3.5 w-3.5" />
                    {busyKey === "bulk" ? "Saving…" : `Clear selected (${selected.size})`}
                  </Button>
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search SKU, ASIN, shipment, reason"
                    className="max-w-sm"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={visible.length > 0 && visible.every((r) => selected.has(r.event_key))}
                        onChange={() => {
                          const allOn = visible.every((r) => selected.has(r.event_key));
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const row of visible) {
                              if (allOn) next.delete(row.event_key);
                              else next.add(row.event_key);
                            }
                            return next;
                          });
                        }}
                        aria-label="Select all visible cases"
                      />
                    </TableHead>
                    <SortHead label="Date" active={sortKey === "event_date"} dir={sortDir} onClick={() => toggleSort("event_date")} />
                    <SortHead label="Reason" active={sortKey === "reason"} dir={sortDir} onClick={() => toggleSort("reason")} />
                    <SortHead label="SKU / ASIN" active={sortKey === "sku"} dir={sortDir} onClick={() => toggleSort("sku")} />
                    <SortHead label="Qty" active={sortKey === "quantity"} dir={sortDir} onClick={() => toggleSort("quantity")} align="right" />
                    <TableHead className="text-right">Shipped</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <SortHead label="Est $" active={sortKey === "estimated_amount"} dir={sortDir} onClick={() => toggleSort("estimated_amount")} align="right" />
                    <TableHead>FC</TableHead>
                    <TableHead>Shipment</TableHead>
                    <TableHead>Reference ID</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => {
                    const day = caseDay(r);
                    const amt = r.estimated_amount;
                    const href = sellerCentralHref(r);
                    const shipment = fbaShipmentId(r.shipment_id);
                    const tracker = isInboundTrackerLink(r);
                    const refId = r.reference_id && r.reference_id !== shipment ? r.reference_id : null;
                    const shipped = inboundShipped(r);
                    const received = inboundReceived(r);
                    return (
                      <TableRow key={r.event_key}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected.has(r.event_key)}
                            onChange={() => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.event_key)) next.delete(r.event_key);
                                else next.add(r.event_key);
                                return next;
                              });
                            }}
                            aria-label={`Select ${r.sku || r.event_key}`}
                          />
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">{day}</TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium">{reasonLabel(r.reason, r.disposition)}</span>
                          <div className="text-[10px] text-muted-foreground">
                            {sourceLabel(r.source)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.sku || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{r.asin || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(caseQty(r))}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {shipped == null ? "—" : fmt(shipped)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {received == null ? "—" : fmt(received)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {amt == null || amt === "" ? "—" : `$${fmtD(caseAmount(r))}`}
                        </TableCell>
                        <TableCell className="text-xs">{r.fulfillment_center || "—"}</TableCell>
                        <TableCell className="text-xs font-mono">
                          {shipment || "—"}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {refId || "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {tracker && href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              Shipment events
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <div className="space-y-1">
                              <p className="text-[11px] leading-snug text-muted-foreground">
                                {IDR_INSTRUCTION}
                              </p>
                              <a
                                href={href || SC_ELIGIBLE_FOR_CLAIM}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                Eligible for claim
                                <ExternalLink className="h-3 w-3" />
                              </a>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => copyPacket(r)}
                              >
                                <ClipboardCopy className="mr-1 h-3 w-3" />
                                {copiedKey === r.event_key ? "Copied" : "Copy case packet"}
                              </Button>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <Badge variant="outline" className="text-[10px] font-normal">
                              Needs case
                            </Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              disabled={busyKey === r.event_key || busyKey === "bulk"}
                              onClick={() => clearRows([r.event_key], clearReason)}
                              title="Clear this row with the selected reason. Evidence stays in history. No Amazon write."
                            >
                              <Check className="mr-0.5 h-3 w-3" />
                              {busyKey === r.event_key ? "Saving…" : "Clear / Mark submitted"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {submittedRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Submitted / cleared ({fmt(submittedRows.length)})
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Evidence kept after Clear / Overview dismiss (filed, reconciled, not pursuing).
                  New CLOSED shorts (new FBA shipment / event_key) still alert.
                </p>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>SKU / ASIN</TableHead>
                      <TableHead className="text-right">Short</TableHead>
                      <TableHead>FC</TableHead>
                      <TableHead>Shipment</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {submittedRows.map((r) => (
                      <TableRow key={r.event_key}>
                        <TableCell className="text-xs tabular-nums">{caseDay(r)}</TableCell>
                        <TableCell>
                          <div className="text-xs font-medium">{r.sku || "—"}</div>
                          <div className="text-[10px] text-muted-foreground">{r.asin || "—"}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(caseQty(r))}</TableCell>
                        <TableCell className="text-xs">{r.fulfillment_center || "—"}</TableCell>
                        <TableCell className="text-xs font-mono">{fbaShipmentId(r.shipment_id) || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{sourceLabel(r.source)}</TableCell>
                        <TableCell className="text-xs">{clearReasonLabel(r)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function CaseKpiCard({
  title,
  events,
  units,
  estimated,
  estimatedKnown,
}: {
  title: string;
  events: number;
  units: number;
  estimated: number;
  estimatedKnown: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[10px] text-muted-foreground uppercase">{title}</p>
        <p className="text-2xl font-semibold tabular-nums">{fmt(events)}</p>
        <p className="text-xs text-muted-foreground">
          {fmt(events)} {KPI_EVENTS_LABEL}
          {estimatedKnown ? ` · ~$${fmtD(estimated)}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          {fmt(units)} {KPI_UNITS_LABEL}
        </p>
      </CardContent>
    </Card>
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
