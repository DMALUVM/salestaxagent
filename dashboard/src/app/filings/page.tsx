"use client";

import { useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule, SalesByState } from "@/lib/types";
import { isRegistered } from "@/lib/compliance-status";
import { normalizeChannel, SHOPIFY, STATE_TAX_RATES } from "@/lib/channels";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { getSupabase } from "@/lib/supabase";
import {
  CheckCircle, CalendarClock, DollarSign, Loader2,
} from "lucide-react";

// Same period-math as liability page and telegram_policy.py
function computeNextDue(
  filedThrough: string | null,
  frequency: string | null,
  dueDay: number,
) {
  if (!filedThrough || !frequency) return null;
  const ft = new Date(filedThrough + "T00:00:00");
  const start = new Date(ft);
  start.setDate(start.getDate() + 1);
  const y = start.getFullYear();
  const m = start.getMonth();
  const freq = frequency.toLowerCase().replace("-", "_");

  let periodEndDate: Date;
  if (freq === "monthly") {
    periodEndDate = new Date(y, m + 1, 0);
  } else if (freq === "quarterly") {
    const qEnd = Math.floor(m / 3) * 3 + 2;
    periodEndDate = new Date(y, qEnd + 1, 0);
  } else if (freq === "semi_annual") {
    periodEndDate = m < 6 ? new Date(y, 6, 0) : new Date(y, 12, 0);
  } else if (freq === "annual") {
    periodEndDate = new Date(y, 12, 0);
  } else {
    periodEndDate = new Date(y, m + 1, 0);
  }

  const dueMonth = periodEndDate.getMonth() + 1;
  const dueYear = dueMonth > 11 ? periodEndDate.getFullYear() + 1 : periodEndDate.getFullYear();
  const dueDate = new Date(dueYear, dueMonth % 12, Math.min(dueDay, 28));

  return {
    periodEnd: periodEndDate.toISOString().slice(0, 10),
    periodLabel: freq === "monthly"
      ? periodEndDate.toISOString().slice(0, 7)
      : freq === "quarterly"
        ? `${periodEndDate.getFullYear()}-Q${Math.floor(periodEndDate.getMonth() / 3) + 1}`
        : freq === "semi_annual"
          ? `${periodEndDate.getFullYear()}-H${periodEndDate.getMonth() < 6 ? 1 : 2}`
          : `${periodEndDate.getFullYear()}`,
    dueDate: dueDate.toISOString().slice(0, 10),
    daysUntil: Math.ceil((dueDate.getTime() - Date.now()) / 86400000),
  };
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface FilingRow {
  state_code: string;
  state_name: string;
  frequency: string;
  filedThrough: string | null;
  periodEnd: string;
  periodLabel: string;
  dueDate: string;
  daysUntil: number;
  shopifySales: number;
  estTax: number;
  rate: number;
}

export default function FilingsPage() {
  const { data: nexus, loading: l1, refetch } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: rules, loading: l2 } = useSupabaseQuery<StateRule>("state_rules");
  const { data: sales, loading: l3 } = useSupabaseQuery<SalesByState>("sales_by_state");
  const [marking, setMarking] = useState<string | null>(null);

  const ruleMap = useMemo(() => {
    const m: Record<string, StateRule> = {};
    for (const r of rules) m[r.state_code] = r;
    return m;
  }, [rules]);

  const rows = useMemo(() => {
    const result: FilingRow[] = [];
    for (const n of nexus) {
      if (!isRegistered(n.is_registered)) continue;
      const r = ruleMap[n.state_code];
      if (!r?.has_sales_tax) continue;

      const freq = n.assigned_frequency ?? r.filing_frequency_default ?? "quarterly";
      const dueDay = r.typical_due_day ?? 20;
      const nd = computeNextDue(n.last_filed_through, freq, dueDay);
      if (!nd) continue;

      // Sum Shopify sales in the open period
      let shopify = 0;
      const ft = n.last_filed_through ?? "";
      for (const s of sales) {
        if (s.state_code !== n.state_code) continue;
        if (normalizeChannel(s.channel) !== SHOPIFY) continue;
        if (ft && s.period_end <= ft) continue;
        shopify += s.gross_sales;
      }

      const rate = STATE_TAX_RATES[n.state_code] ?? 0;

      result.push({
        state_code: n.state_code,
        state_name: r.state_name ?? n.state_code,
        frequency: freq,
        filedThrough: n.last_filed_through,
        periodEnd: nd.periodEnd,
        periodLabel: nd.periodLabel,
        dueDate: nd.dueDate,
        daysUntil: nd.daysUntil,
        shopifySales: shopify,
        estTax: shopify * rate,
        rate,
      });
    }
    return result.sort((a, b) => a.daysUntil - b.daysUntil);
  }, [nexus, rules, sales, ruleMap]);

  async function handleMarkFiled(row: FilingRow) {
    setMarking(row.state_code);
    try {
      const sb = getSupabase();
      // Advance last_filed_through to this period's end
      await sb.from("nexus_status").update({
        last_filed_through: row.periodEnd,
      }).eq("state_code", row.state_code);

      // Mark matching filing_calendar row as filed
      await sb.from("filing_calendar").update({
        status: "filed",
        filed_date: new Date().toISOString().slice(0, 10),
      }).eq("state_code", row.state_code)
        .eq("period_label", row.periodLabel)
        .eq("status", "pending");

      refetch();
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMarking(null);
    }
  }

  if (l1 || l2 || l3) return <LoadingState />;

  const overdue = rows.filter((r) => r.daysUntil < 0);
  const upcoming = rows.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 14);
  const totalEstTax = rows.reduce((s, r) => s + r.estTax, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Filing Checklist</h1>
        <p className="text-sm text-muted-foreground">
          Next open period per registered state. Mark filed to advance.
        </p>
      </div>

      <Disclaimer />

      <div className="grid grid-cols-3 gap-3">
        <Card className={overdue.length > 0 ? "border-red-200 dark:border-red-900" : ""}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CalendarClock className={`h-4 w-4 ${overdue.length > 0 ? "text-red-500" : "text-muted-foreground"}`} />
              <span className="text-2xl font-bold">{overdue.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">Overdue</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-amber-500" />
              <span className="text-2xl font-bold">{upcoming.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">Due within 14d</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-amber-500" />
              <span className="text-2xl font-bold">${fmt(totalEstTax)}</span>
            </div>
            <p className="text-xs text-muted-foreground">Est. seller tax (all periods)</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Open Periods</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Days</TableHead>
                <TableHead className="text-right">Shopify $</TableHead>
                <TableHead className="text-right">Est. Tax</TableHead>
                <TableHead className="w-24">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No open filing periods. All registered states are up to date.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.state_code}>
                  <TableCell className="font-medium">
                    {r.state_code}
                    <span className="ml-1 text-xs text-muted-foreground hidden sm:inline">{r.state_name}</span>
                  </TableCell>
                  <TableCell className="text-sm">{r.periodLabel}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs capitalize">
                      {r.frequency.replace("_", "-")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{r.dueDate}</TableCell>
                  <TableCell>
                    <span className={`text-xs font-medium ${
                      r.daysUntil < 0 ? "text-red-600" : r.daysUntil <= 7 ? "text-amber-600" : "text-muted-foreground"
                    }`}>
                      {r.daysUntil < 0 ? `${Math.abs(r.daysUntil)}d overdue` : `${r.daysUntil}d`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    ${fmt(r.shopifySales)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium text-amber-600 dark:text-amber-400">
                    ${fmt(r.estTax)}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={marking === r.state_code}
                      onClick={() => handleMarkFiled(r)}
                    >
                      {marking === r.state_code ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <CheckCircle className="h-3 w-3 mr-1" />
                      )}
                      Mark Filed
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground">
        Est. Tax = Shopify sales since last filed-through x base state rate.
        Not filing-ready — no local surcharges, exemptions, or credits.
        Amazon remits separately; not included in seller-owed estimate.
      </p>
    </div>
  );
}
