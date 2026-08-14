"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { FilingEntry } from "@/lib/types";
import { FilingStatusBadge, FrequencyBadge } from "@/components/status-badge";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Calendar, Check, Clock, AlertTriangle } from "lucide-react";

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
    await getSupabase()
      .from("filing_calendar")
      .update({
        status: "filed",
        filed_amount: amount ? parseFloat(amount) : null,
        notes: notes || null,
        filed_at: new Date().toISOString(),
      })
      .eq("id", filing.id);
    setSubmitting(false);
    setOpen(false);
    onComplete();
  }

  return (
    <>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen(true)}>
        <Check className="mr-1 h-3 w-3" />
        Complete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Mark Filing Complete — {filing.state_code} {filing.period_label}
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
          <Button onClick={handleSubmit} disabled={submitting} className="w-full">
            {submitting ? "Saving..." : "Mark as Filed"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

function daysUntil(dateStr: string) {
  return Math.ceil(
    (new Date(dateStr).getTime() - Date.now()) / 86400000
  );
}

function FilingTable({
  rows,
  showComplete,
  onRefetch,
}: {
  rows: FilingEntry[];
  showComplete?: boolean;
  onRefetch: () => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Calendar className="h-8 w-8" />}
        title="No filings"
        description="No filings in this category."
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
            <TableHead>Frequency</TableHead>
            <TableHead>Status</TableHead>
            {showComplete && <TableHead className="w-24" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((f) => {
            const days = daysUntil(f.due_date);
            const isOverdue = f.status === "pending" && days < 0;

            return (
              <TableRow key={f.id} className={isOverdue ? "bg-red-50/50 dark:bg-red-950/20" : ""}>
                <TableCell className="font-semibold">{f.state_code}</TableCell>
                <TableCell className="text-sm">{f.period_label}</TableCell>
                <TableCell className="text-sm">
                  {new Date(f.due_date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </TableCell>
                <TableCell>
                  {f.status === "filed" ? (
                    <span className="text-xs text-muted-foreground">—</span>
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
                      {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days}d`}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <FrequencyBadge frequency={f.frequency} />
                </TableCell>
                <TableCell>
                  <FilingStatusBadge status={isOverdue ? "overdue" : f.status} />
                </TableCell>
                {showComplete && (
                  <TableCell>
                    {f.status === "pending" && (
                      <MarkCompleteDialog filing={f} onComplete={onRefetch} />
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CalendarPage() {
  const { data: filings, loading, refetch } = useSupabaseQuery<FilingEntry>(
    "filing_calendar",
    { orderBy: "due_date", ascending: true }
  );

  if (loading) return <LoadingState />;

  const today = new Date().toISOString().slice(0, 10);
  const pending = filings.filter((f) => f.status === "pending");
  const overdue = pending.filter((f) => f.due_date < today);
  const upcoming = pending.filter((f) => f.due_date >= today);
  const completed = filings.filter((f) => f.status === "filed");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Filing Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Track deadlines and mark filings complete
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={overdue.length > 0 ? "border-red-200 dark:border-red-900" : ""}>
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle
              className={`h-5 w-5 ${overdue.length > 0 ? "text-red-500" : "text-muted-foreground/40"}`}
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

      <Tabs defaultValue={overdue.length > 0 ? "overdue" : "upcoming"}>
        <TabsList>
          {overdue.length > 0 && (
            <TabsTrigger value="overdue" className="text-red-600 dark:text-red-400">
              Overdue ({overdue.length})
            </TabsTrigger>
          )}
          <TabsTrigger value="upcoming">Upcoming ({upcoming.length})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({completed.length})</TabsTrigger>
        </TabsList>

        {overdue.length > 0 && (
          <TabsContent value="overdue" className="mt-4">
            <Card>
              <CardContent className="p-0">
                <FilingTable rows={overdue} showComplete onRefetch={refetch} />
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="upcoming" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <FilingTable rows={upcoming} showComplete onRefetch={refetch} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="completed" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <FilingTable rows={completed} onRefetch={refetch} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Disclaimer />
    </div>
  );
}
