"use client";

import { useEffect, useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule, SalesByState } from "@/lib/types";
import { normalizeChannel, isSellerResponsible, SHOPIFY, STATE_TAX_RATES } from "@/lib/channels";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Disclaimer } from "@/components/disclaimer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Calendar, CheckCircle, AlertTriangle, Clock } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Compute next unfiled period due date from filed_through + frequency.
 *
 * Period starts the day after filed_through.  Due date = dueDay of the
 * month after the period end.
 */
function computeNextDue(
  filedThrough: string | null,
  frequency: string | null,
  dueDay: number,
): { due: string; days: number; periodEnd: string; periodLabel: string } | null {
  if (!filedThrough || !frequency) return null;

  const ft = new Date(filedThrough + "T00:00:00");
  const start = new Date(ft);
  start.setDate(start.getDate() + 1);

  const y = start.getFullYear();
  const m = start.getMonth(); // 0-based

  let periodEndDate: Date;
  const freq = frequency.toLowerCase().replace("-", "_");

  if (freq === "monthly") {
    periodEndDate = new Date(y, m + 1, 0);
  } else if (freq === "quarterly") {
    const qEnd = Math.floor(m / 3) * 3 + 2;
    periodEndDate = new Date(y, qEnd + 1, 0);
  } else if (freq === "semi_annual" || freq === "semi-annual") {
    periodEndDate = m < 6 ? new Date(y, 6, 0) : new Date(y, 12, 0);
  } else if (freq === "annual") {
    periodEndDate = new Date(y, 12, 0);
  } else {
    periodEndDate = new Date(y, m + 1, 0);
  }

  const dueMonth = periodEndDate.getMonth() + 1;
  const dueYear =
    dueMonth > 11
      ? periodEndDate.getFullYear() + 1
      : periodEndDate.getFullYear();
  const dueDate = new Date(dueYear, dueMonth % 12, Math.min(dueDay, 28));

  const periodEnd = periodEndDate.toISOString().slice(0, 10);
  const due = dueDate.toISOString().slice(0, 10);
  const days = Math.ceil((dueDate.getTime() - Date.now()) / 86400000);

  // Build human-readable period label
  const peMonth = periodEndDate.getMonth();
  const peYear = periodEndDate.getFullYear();
  let periodLabel: string;
  if (freq === "monthly") {
    periodLabel = periodEndDate.toLocaleString(undefined, {
      month: "short",
      year: "numeric",
    });
  } else if (freq === "quarterly") {
    const q = Math.floor(peMonth / 3) + 1;
    periodLabel = `Q${q} ${peYear}`;
  } else if (freq === "semi_annual" || freq === "semi-annual") {
    periodLabel = peMonth < 6 ? `H1 ${peYear}` : `H2 ${peYear}`;
  } else if (freq === "annual") {
    periodLabel = `${peYear}`;
  } else {
    periodLabel = periodEnd;
  }

  return { due, days, periodEnd, periodLabel };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilingRow {
  state_code: string;
  state_name: string;
  frequency: string;
  periodLabel: string;
  periodEnd: string;
  dueDate: string;
  daysUntil: number;
  shopifySales: number;
  estTax: number;
  rate: number;
  last_filed_through: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FilingsPage() {
  const { data: nexus, loading: l1, refetch: refetchNexus } =
    useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: rules, loading: l2 } = useSupabaseQuery<StateRule>(
    "state_rules",
    { orderBy: "state_code", ascending: true },
  );
  const { data: sales, loading: l3 } = useSupabaseQuery<SalesByState>(
    "sales_by_state",
  );

  const [markingFiled, setMarkingFiled] = useState<string | null>(null);

  const rows = useMemo(() => {
    const rulesMap = new Map(rules.map((r) => [r.state_code, r]));

    const result: FilingRow[] = [];

    for (const n of nexus) {
      const isReg = n.is_registered === true || (n.is_registered as unknown) === "true";
      if (!isReg) continue;

      const rule = rulesMap.get(n.state_code);
      if (!rule) continue;

      const freq = n.assigned_frequency ?? rule.filing_frequency_default;
      if (!freq) continue;

      const dueDay = rule.typical_due_day ?? 20;
      const lft = n.last_filed_through;
      const nextDue = computeNextDue(lft, freq, dueDay);
      if (!nextDue) continue;

      // Sum seller-responsible sales since last_filed_through
      // (Shopify Online Store only — excludes Shop channel and Amazon)
      let shopifySince = 0;
      for (const s of sales) {
        if (s.state_code !== n.state_code) continue;
        if (!isSellerResponsible(s.channel ?? "")) continue;
        if (lft && s.period_end <= lft) continue;
        shopifySince += Number(s.gross_sales) || 0;
      }

      const rate = STATE_TAX_RATES[n.state_code] ?? 0;
      const estTax = shopifySince * rate;

      result.push({
        state_code: n.state_code,
        state_name: rule.state_name,
        frequency: freq,
        periodLabel: nextDue.periodLabel,
        periodEnd: nextDue.periodEnd,
        dueDate: nextDue.due,
        daysUntil: nextDue.days,
        shopifySales: Math.round(shopifySince * 100) / 100,
        estTax: Math.round(estTax * 100) / 100,
        rate,
        last_filed_through: lft ?? "",
      });
    }

    // Sort by days until due ascending (most urgent first)
    result.sort((a, b) => a.daysUntil - b.daysUntil);
    return result;
  }, [nexus, rules, sales]);

  async function handleMarkFiled(row: FilingRow) {
    setMarkingFiled(row.state_code);
    try {
      await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state_code: row.state_code,
          is_registered: true,
          last_filed_through: row.periodEnd,
        }),
      });
      refetchNexus();
    } catch (e) {
      console.error("Failed to mark filed:", e);
    } finally {
      setMarkingFiled(null);
    }
  }

  if (l1 || l2 || l3) return <LoadingState />;

  const overdue = rows.filter((r) => r.daysUntil < 0);
  const upcoming = rows.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 30);
  const totalEstTax = rows.reduce((sum, r) => sum + r.estTax, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Filing Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Upcoming filings for registered states
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Calendar className="h-5 w-5 text-primary" />
            <div>
              <p className="text-2xl font-semibold">{rows.length}</p>
              <p className="text-xs text-muted-foreground">Active Filings</p>
            </div>
          </CardContent>
        </Card>
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
              <p className="text-2xl font-semibold">${fmt(totalEstTax)}</p>
              <p className="text-xs text-muted-foreground">Est. Tax Due</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filing table */}
      {rows.length === 0 ? (
        <EmptyState
          icon={<Calendar className="h-8 w-8" />}
          title="No filings"
          description="Register a state and set its filing frequency to see upcoming filings."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">State</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead className="w-16 text-right">Days</TableHead>
                    <TableHead className="text-right">Shopify $</TableHead>
                    <TableHead className="text-right">Est Tax</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const isOverdue = r.daysUntil < 0;
                    const isUrgent = r.daysUntil >= 0 && r.daysUntil <= 7;
                    const isSoon = r.daysUntil > 7 && r.daysUntil <= 30;
                    return (
                      <TableRow key={r.state_code}>
                        <TableCell className="font-semibold">
                          {r.state_code}
                        </TableCell>
                        <TableCell className="text-sm">
                          {r.periodLabel}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize text-xs">
                            {r.frequency.replace("_", "-")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{r.dueDate}</TableCell>
                        <TableCell className="text-right">
                          {isOverdue ? (
                            <Badge
                              variant="destructive"
                              className="text-xs"
                            >
                              {r.daysUntil}d
                            </Badge>
                          ) : isUrgent ? (
                            <Badge className="bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 text-xs">
                              {r.daysUntil}d
                            </Badge>
                          ) : isSoon ? (
                            <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 text-xs">
                              {r.daysUntil}d
                            </Badge>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              {r.daysUntil}d
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          ${fmt(r.shopifySales)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          ${fmt(r.estTax)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markingFiled === r.state_code}
                            onClick={() => handleMarkFiled(r)}
                          >
                            <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                            {markingFiled === r.state_code
                              ? "Saving..."
                              : "Mark Filed"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Disclaimer />
    </div>
  );
}
