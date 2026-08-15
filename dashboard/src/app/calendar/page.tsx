"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { FilingEntry } from "@/lib/types";
import { FilingStatusBadge, FrequencyBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  async function handleSubmit() {
    setSubmitting(true);
    const sb = getSupabase();
    await sb
      .from("filing_calendar")
      .update({
        status: "filed",
        filed_amount: amount ? parseFloat(amount) : null,
        filed_notes: notes || null,
        filed_date: new Date().toISOString().slice(0, 10),
      })
      .eq("id", filing.id);

    // Update last_filed_through on nexus_status if this period is newer
    const { data: nexus } = await sb
      .from("nexus_status")
      .select("last_filed_through")
      .eq("state_code", filing.state_code)
      .limit(1);

    if (nexus?.[0] && filing.period_end) {
      const current = nexus[0].last_filed_through ?? "";
      if (filing.period_end > current) {
        await sb
          .from("nexus_status")
          .update({ last_filed_through: filing.period_end })
          .eq("state_code", filing.state_code);
      }
    }

    setSubmitting(false);
    setOpen(false);
    setAmount("");
    setNotes("");
    onComplete();
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
        Filed
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

  async function mark() {
    setBusy(true);
    const sb = getSupabase();
    await sb
      .from("filing_calendar")
      .update({
        status: "filed",
        filed_amount: null,
        filed_notes: null,
        filed_date: new Date().toISOString().slice(0, 10),
      })
      .eq("id", filing.id);

    // Update last_filed_through
    if (filing.period_end) {
      const { data: nexus } = await sb
        .from("nexus_status")
        .select("last_filed_through")
        .eq("state_code", filing.state_code)
        .limit(1);
      if (nexus?.[0]) {
        const current = nexus[0].last_filed_through ?? "";
        if (filing.period_end > current) {
          await sb
            .from("nexus_status")
            .update({ last_filed_through: filing.period_end })
            .eq("state_code", filing.state_code);
        }
      }
    }

    setBusy(false);
    onDone();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
      onClick={mark}
      disabled={busy}
    >
      <Check className="mr-1 h-3 w-3" />
      {busy ? "..." : "Filed"}
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

  async function undo() {
    setBusy(true);
    await getSupabase()
      .from("filing_calendar")
      .update({
        status: "pending",
        filed_amount: null,
        filed_notes: null,
        filed_date: null,
      })
      .eq("id", filing.id);
    setBusy(false);
    onDone();
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-muted-foreground"
      onClick={undo}
      disabled={busy}
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

  async function markAll() {
    setBusy(true);
    const sb = getSupabase();
    const today = new Date().toISOString().slice(0, 10);

    // Mark all overdue as filed
    const ids = overdue.map((f) => f.id);
    await sb
      .from("filing_calendar")
      .update({
        status: "filed",
        filed_amount: null,
        filed_notes: "Bulk-marked as filed",
        filed_date: today,
      })
      .in("id", ids);

    // Update last_filed_through for each affected state
    const byState: Record<string, string> = {};
    for (const f of overdue) {
      if (
        f.period_end &&
        (!byState[f.state_code] || f.period_end > byState[f.state_code])
      ) {
        byState[f.state_code] = f.period_end;
      }
    }
    for (const [sc, pe] of Object.entries(byState)) {
      const { data: nexus } = await sb
        .from("nexus_status")
        .select("last_filed_through")
        .eq("state_code", sc)
        .limit(1);
      if (nexus?.[0]) {
        const current = nexus[0].last_filed_through ?? "";
        if (pe > current) {
          await sb
            .from("nexus_status")
            .update({ last_filed_through: pe })
            .eq("state_code", sc);
        }
      }
    }

    setBusy(false);
    onDone();
  }

  if (overdue.length < 2) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={markAll}
      disabled={busy}
      className="border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
    >
      <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
      {busy
        ? "Marking..."
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
            ? "No upcoming filings."
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
            <TableHead className="w-32" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((f) => {
            const days = daysUntil(f.due_date);
            const isOverdue = f.status !== "filed" && days < 0;

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
                  <FilingStatusBadge
                    status={isOverdue ? "overdue" : f.status}
                  />
                </TableCell>
                <TableCell>
                  {f.status !== "filed" ? (
                    <div className="flex gap-1">
                      <QuickMarkButton filing={f} onDone={onRefetch} />
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
    refetch,
  } = useSupabaseQuery<FilingEntry>("filing_calendar", {
    orderBy: "due_date",
    ascending: true,
  });

  if (loading) return <LoadingState />;

  const today = new Date().toISOString().slice(0, 10);
  const pending = filings.filter(
    (f) => f.status === "pending" || f.status === "late",
  );
  const overdue = pending.filter((f) => f.due_date < today);
  const upcoming = pending.filter((f) => f.due_date >= today);
  const completed = filings.filter((f) => f.status === "filed");

  const defaultTab =
    overdue.length > 0
      ? "overdue"
      : upcoming.length > 0
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
              <p className="text-2xl font-semibold">{upcoming.length}</p>
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

      {/* Tabs */}
      <Tabs defaultValue={defaultTab}>
        <div className="flex items-center justify-between gap-4">
          <TabsList>
            {overdue.length > 0 && (
              <TabsTrigger
                value="overdue"
                className="text-red-600 dark:text-red-400"
              >
                Overdue ({overdue.length})
              </TabsTrigger>
            )}
            <TabsTrigger value="upcoming">
              Upcoming ({upcoming.length})
            </TabsTrigger>
            <TabsTrigger value="completed">
              Completed ({completed.length})
            </TabsTrigger>
          </TabsList>

          {overdue.length > 0 && (
            <BulkMarkOverdueButton overdue={overdue} onDone={refetch} />
          )}
        </div>

        {overdue.length > 0 && (
          <TabsContent value="overdue" className="mt-4">
            <Card>
              <CardContent className="p-0">
                <FilingTable
                  rows={overdue}
                  mode="overdue"
                  onRefetch={refetch}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="upcoming" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <FilingTable
                rows={upcoming}
                mode="upcoming"
                onRefetch={refetch}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completed" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <FilingTable
                rows={completed}
                mode="completed"
                onRefetch={refetch}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {filings.length === 0 && (
        <GenerateFilingsCard onDone={refetch} />
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
