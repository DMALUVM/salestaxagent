"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { FilingEntry, NexusStatus } from "@/lib/types";
import { FilingStatusBadge, FrequencyBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { classifyFilings, type FilingRow, type NexusRow } from "@/lib/filing-eligibility";
import {
  DUE_WINDOW_LABELS,
  filterByDueWindow,
  groupByDueMonth,
  type DueWindow,
} from "@/lib/filing-groups";
import { agentToday } from "@/lib/as-of";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSupabase } from "@/lib/supabase";
import {
  Calendar,
  Check,
  CheckCheck,
  Clock,
  AlertTriangle,
  Undo2,
} from "lucide-react";

function throwIfSbError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/** Recompute nexus_status.last_filed_through from remaining filed rows. */
async function syncLastFiledThrough(stateCode: string) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("filing_calendar")
    .select("period_end")
    .eq("state_code", stateCode)
    .eq("status", "filed");
  throwIfSbError(error);
  const maxEnd =
    (data ?? [])
      .map((r) => r.period_end as string | null)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;
  const { error: upErr } = await sb
    .from("nexus_status")
    .update({ last_filed_through: maxEnd })
    .eq("state_code", stateCode);
  throwIfSbError(upErr);
}

// ---------------------------------------------------------------------------
// Mark-complete dialog (single filing)
// ---------------------------------------------------------------------------

function MarkCompleteDialog({
  filing,
  onComplete,
}: {
  filing: FilingEntry;
  onComplete: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setErr(null);
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("filing_calendar")
        .update({
          status: "filed",
          filed_amount: amount ? parseFloat(amount) : null,
          filed_notes: notes || null,
          filed_date: new Date().toISOString().slice(0, 10),
        })
        .eq("id", filing.id);
      throwIfSbError(error);
      await syncLastFiledThrough(filing.state_code);
      setOpen(false);
      setAmount("");
      setNotes("");
      onComplete();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => setOpen(true)}
      >
        <Check className="mr-1 h-3 w-3" />
        File with amount
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Mark Filed — {filing.state_code} {filing.period_label}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <label className="text-sm font-medium">Amount Filed</label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00 (leave blank for zero return)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Notes</label>
              <Input
                placeholder="Optional notes..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1"
              />
            </div>
            {err && (
              <p className="text-xs text-red-600 dark:text-red-400">{err}</p>
            )}
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full"
            >
              {submitting ? "Saving..." : "Mark as Filed"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Quick-mark button (inline, no dialog — for bulk clearing)
// ---------------------------------------------------------------------------

function QuickMarkButton({
  filing,
  onDone,
}: {
  filing: FilingEntry;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function mark() {
    setBusy(true);
    setErr(null);
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("filing_calendar")
        .update({
          status: "filed",
          filed_amount: null,
          filed_notes: null,
          filed_date: new Date().toISOString().slice(0, 10),
        })
        .eq("id", filing.id);
      throwIfSbError(error);
      await syncLastFiledThrough(filing.state_code);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
      onClick={mark}
      disabled={busy}
      title={err ?? "Mark this period filed"}
    >
      <Check className="mr-1 h-3 w-3" />
      {busy ? "..." : err ? "Retry" : "Mark filed"}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Undo (revert filed → pending)
// ---------------------------------------------------------------------------

function UndoButton({
  filing,
  onDone,
}: {
  filing: FilingEntry;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setErr(null);
    try {
      const { error } = await getSupabase()
        .from("filing_calendar")
        .update({
          status: "pending",
          filed_amount: null,
          filed_notes: null,
          filed_date: null,
        })
        .eq("id", filing.id);
      throwIfSbError(error);
      await syncLastFiledThrough(filing.state_code);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-muted-foreground"
      onClick={undo}
      disabled={busy}
      title={err ?? "Revert to pending and roll back Filed Thru"}
    >
      <Undo2 className="mr-1 h-3 w-3" />
      {busy ? "..." : "Undo"}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Bulk mark-all-overdue
// ---------------------------------------------------------------------------

function BulkMarkOverdueButton({
  overdue,
  onDone,
}: {
  overdue: FilingEntry[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function markAll() {
    setBusy(true);
    setErr(null);
    try {
      const sb = getSupabase();
      const today = new Date().toISOString().slice(0, 10);
      const ids = overdue.map((f) => f.id);
      const { error } = await sb
        .from("filing_calendar")
        .update({
          status: "filed",
          filed_amount: null,
          filed_notes: "Bulk-marked as filed",
          filed_date: today,
        })
        .in("id", ids);
      throwIfSbError(error);
      const states = [...new Set(overdue.map((f) => f.state_code))];
      for (const sc of states) {
        await syncLastFiledThrough(sc);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (overdue.length < 2) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={markAll}
      disabled={busy}
      title={err ?? undefined}
      className="border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
    >
      <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
      {busy
        ? "Marking..."
        : err
          ? "Retry bulk mark"
          : `Mark all ${overdue.length} as filed`}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysUntil(dateStr: string) {
  return Math.ceil(
    (new Date(dateStr).getTime() - Date.now()) / 86400000,
  );
}

// ---------------------------------------------------------------------------
// Filing table
// ---------------------------------------------------------------------------

/**
 * Mark a period as not owed — a genuine exemption, or a false positive the
 * user wants gone.
 *
 * Both land on `not_required` because the filing_calendar CHECK constraint
 * allows pending/filed/late/not_required only; the user's reason is kept in
 * filed_notes rather than invented as a status the database would reject. The
 * nightly rebuild preserves settled periods, so this does not come back.
 */
function NotRequiredButton({
  filing,
  onDone,
}: {
  filing: FilingEntry;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function mark() {
    const reason = window.prompt(
      `Mark ${filing.state_code} ${filing.period_label} as NOT required.\n\n` +
        "Why? (e.g. \"below threshold\", \"marketplace facilitator files this\", " +
        "\"duplicate period\")",
      "",
    );
    if (reason === null) return; // cancelled
    setBusy(true);
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("filing_calendar")
        .update({
          status: "not_required",
          filed_notes: reason.trim() || "marked not required by user",
        })
        .eq("id", filing.id);
      throwIfSbError(error);
      onDone();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={mark}
      disabled={busy}
      title="Not required / dismiss false positive"
      className="text-xs"
    >
      {busy ? "…" : "N/A"}
    </Button>
  );
}

function MonthGroupedFilings({
  rows,
  mode,
  onRefetch,
}: {
  rows: FilingEntry[];
  mode: "overdue" | "upcoming" | "completed";
  onRefetch: () => void;
}) {
  const groups = groupByDueMonth(rows);
  if (rows.length === 0) {
    return <FilingTable rows={rows} mode={mode} onRefetch={onRefetch} />;
  }
  if (groups.length <= 1) {
    return <FilingTable rows={rows} mode={mode} onRefetch={onRefetch} />;
  }
  return (
    <div className="divide-y">
      {groups.map((g, i) => (
        <details key={g.key} open={i < 2} className="group">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium hover:bg-muted/50">
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground group-open:hidden">▸</span>
              <span className="hidden text-muted-foreground group-open:inline">▾</span>
              {g.label}
              <Badge variant="outline" className="text-[10px]">{g.rows.length}</Badge>
            </span>
          </summary>
          <FilingTable rows={g.rows} mode={mode} onRefetch={onRefetch} />
        </details>
      ))}
    </div>
  );
}

function FilingTable({
  rows,
  mode,
  onRefetch,
}: {
  rows: FilingEntry[];
  mode: "overdue" | "upcoming" | "completed";
  onRefetch: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Calendar className="h-8 w-8" />}
        title="No filings"
        description={
          mode === "overdue"
            ? "Nothing overdue. You're caught up!"
            : mode === "upcoming"
            ? "No upcoming filings in this window."
            : "No completed filings yet."
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">State</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Due Date</TableHead>
            <TableHead className="w-20">Days</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-56" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((f) => {
            const days = daysUntil(f.due_date);
            const isOverdue =
              f.status !== "filed" &&
              f.status !== "not_required" &&
              (f.status === "late" || days < 0);
            const badgeStatus = isOverdue
              ? (f.status === "late" ? "late" : "overdue")
              : f.status;

            return (
              <TableRow
                key={f.id}
                className={
                  isOverdue ? "bg-red-50/50 dark:bg-red-950/20" : ""
                }
              >
                <TableCell className="font-semibold">
                  {f.state_code}
                </TableCell>
                <TableCell className="text-sm">{f.period_label}</TableCell>
                <TableCell className="text-sm">
                  {new Date(f.due_date + "T00:00:00").toLocaleDateString(
                    "en-US",
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                </TableCell>
                <TableCell>
                  {f.status === "filed" ? (
                    <span className="text-xs text-muted-foreground">
                      &mdash;
                    </span>
                  ) : (
                    <span
                      className={`text-xs font-medium ${
                        days < 0
                          ? "text-red-600 dark:text-red-400"
                          : days <= 7
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {days < 0
                        ? `${Math.abs(days)}d overdue`
                        : days === 0
                        ? "Today"
                        : `${days}d`}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <FrequencyBadge frequency={f.period_type} />
                </TableCell>
                <TableCell>
                  <FilingStatusBadge status={badgeStatus} />
                </TableCell>
                <TableCell>
                  {f.status !== "filed" ? (
                    <div className="flex gap-1">
                      <QuickMarkButton filing={f} onDone={onRefetch} />
                      <NotRequiredButton filing={f} onDone={onRefetch} />
                      <MarkCompleteDialog
                        filing={f}
                        onComplete={onRefetch}
                      />
                    </div>
                  ) : (
                    <UndoButton filing={f} onDone={onRefetch} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CalendarPage() {
  const {
    data: filings,
    loading,
    error,
    refetch,
  } = useSupabaseQuery<FilingEntry>("filing_calendar", {
    orderBy: "due_date",
    ascending: true,
  });
  const { data: nexusData, loading: l2, error: e2, refetch: refetchNexus } = useSupabaseQuery<NexusStatus>("nexus_status");
  const [dueWindow, setDueWindow] = useState<DueWindow>("90d");
  const refreshAll = () => {
    refetch();
    refetchNexus();
  };

  if (loading || l2) return <LoadingState />;
  if (error || e2) {
    return (
      <QueryError
        message={error || e2}
        onRetry={() => {
          refetch();
          refetchNexus();
        }}
      />
    );
  }

  // Eligibility comes from lib/filing-eligibility.ts, mirroring
  // src/calendar/eligibility.py, so this page, the Pulse chips, the Telegram
  // digest and the filing-audit CLI agree on what "overdue" means.
  //
  // This used to filter on status + registration_date only: it never checked
  // is_registered, never honoured nexus_status.last_filed_through, and never
  // noticed a state carrying two overlapping period cadences.
  const today = agentToday();
  const cls = classifyFilings<FilingEntry & FilingRow>(
    filings as Array<FilingEntry & FilingRow>,
    nexusData as unknown as NexusRow[],
    today,
  );
  const overdue = cls.overdue;
  const upcomingAll = cls.upcoming;
  const upcoming = filterByDueWindow(upcomingAll, today, dueWindow);
  const completed = filings.filter((f) => f.status === "filed");
  // Rows excluded for a reason other than "already settled" — shown so a
  // period that vanished from Overdue is explainable rather than mysterious.
  const notApplicable = cls.excluded.filter((f) => f.excluded_reason !== "settled");

  const defaultTab =
    overdue.length > 0
      ? "overdue"
      : upcomingAll.length > 0
      ? "upcoming"
      : "completed";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Filing Calendar
        </h1>
        <p className="text-sm text-muted-foreground">
          Track deadlines and mark filings complete
        </p>
      </div>

      {overdue.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50/80 px-4 py-3 text-sm dark:border-red-900 dark:bg-red-950/40">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          <div>
            <p className="font-medium text-red-800 dark:text-red-200">
              {overdue.length} late filing{overdue.length === 1 ? "" : "s"} past due
            </p>
            <p className="text-xs text-red-700/80 dark:text-red-300/80">
              Open the Overdue tab to file or mark not required.
            </p>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card
          className={
            overdue.length > 0 ? "border-red-200 dark:border-red-900" : ""
          }
        >
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle
              className={`h-5 w-5 ${
                overdue.length > 0
                  ? "text-red-500"
                  : "text-muted-foreground/40"
              }`}
            />
            <div>
              <p className="text-2xl font-semibold">{overdue.length}</p>
              <p className="text-xs text-muted-foreground">Overdue</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Clock className="h-5 w-5 text-amber-500" />
            <div>
              <p className="text-2xl font-semibold">{upcomingAll.length}</p>
              <p className="text-xs text-muted-foreground">Upcoming</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Check className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-2xl font-semibold">{completed.length}</p>
              <p className="text-xs text-muted-foreground">Completed</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[10px] uppercase text-muted-foreground">Due window (Upcoming)</span>
        {(["30d", "90d", "all"] as DueWindow[]).map((w) => (
          <Button
            key={w}
            variant={dueWindow === w ? "default" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => setDueWindow(w)}
          >
            {DUE_WINDOW_LABELS[w]}
          </Button>
        ))}
        {dueWindow !== "all" && upcomingAll.length !== upcoming.length && (
          <span className="ml-2 text-xs text-muted-foreground">
            Showing {upcoming.length} of {upcomingAll.length} upcoming
          </span>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue={defaultTab}>
        <div className="flex items-center justify-between gap-4">
          <TabsList>
            <TabsTrigger
              value="overdue"
              className={
                overdue.length > 0
                  ? "text-red-600 dark:text-red-400"
                  : undefined
              }
            >
              Overdue ({overdue.length})
            </TabsTrigger>
            <TabsTrigger value="upcoming">
              Upcoming ({upcomingAll.length})
            </TabsTrigger>
            <TabsTrigger value="not_applicable">
              Not applicable ({notApplicable.length})
            </TabsTrigger>
            <TabsTrigger value="completed">
              Completed ({completed.length})
            </TabsTrigger>
          </TabsList>

          {overdue.length > 0 && (
            <BulkMarkOverdueButton overdue={overdue} onDone={refreshAll} />
          )}
        </div>

        <TabsContent value="overdue" className="mt-4">
          <Card className={overdue.length > 0 ? "border-red-200 dark:border-red-900" : ""}>
            <CardContent className="p-0">
              <MonthGroupedFilings
                rows={overdue}
                mode="overdue"
                onRefetch={refreshAll}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="upcoming" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <MonthGroupedFilings
                rows={upcoming}
                mode="upcoming"
                onRefetch={refreshAll}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="not_applicable" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-3">
                Periods that are not open sales-tax obligations. Shown so a
                deadline that disappeared from Overdue is explainable — not
                because anything is wrong.
              </p>
              {notApplicable.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing excluded.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-4">State</th>
                        <th className="py-1 pr-4">Period</th>
                        <th className="py-1 pr-4">Due</th>
                        <th className="py-1 pr-4">Reason</th>
                        <th className="py-1">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {notApplicable.map((f) => (
                        <tr key={f.id} className="border-t">
                          <td className="py-1 pr-4 font-medium">{f.state_code}</td>
                          <td className="py-1 pr-4">{f.period_label}</td>
                          <td className="py-1 pr-4 tabular-nums">{f.due_date}</td>
                          <td className="py-1 pr-4">
                            <Badge variant="outline" className="text-[9px] whitespace-nowrap">
                              {f.excluded_reason.replace(/_/g, " ")}
                            </Badge>
                          </td>
                          <td className="py-1 text-muted-foreground">{f.excluded_detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completed" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <MonthGroupedFilings
                rows={completed}
                mode="completed"
                onRefetch={refreshAll}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {filings.length === 0 && (
        <GenerateFilingsCard onDone={refreshAll} />
      )}
    </div>
  );
}

function GenerateFilingsCard({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/generate-filings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (data.success) {
        setResult(
          `Generated ${data.entries_created} periods for ${data.states?.length ?? 0} states.`,
        );
        onDone();
      } else {
        setResult(data.error ?? "Failed to generate.");
      }
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-8 text-center">
        <Calendar className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          No filing calendar entries yet.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Register states on the{" "}
          <a href="/registrations" className="underline">
            Registrations
          </a>{" "}
          page first, then generate filing periods.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={generate}
          disabled={busy}
        >
          {busy ? "Generating..." : "Generate Filing Schedule"}
        </Button>
        {result && (
          <p className="mt-2 text-xs text-muted-foreground">{result}</p>
        )}
      </CardContent>
    </Card>
  );
}
