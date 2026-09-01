"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";
import type { DailyReconcileSummary } from "@/lib/ads-reconcile";

function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const TYPE_BADGE: Record<string, string> = {
  SP: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  SB: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  SD: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};

export function PpcReconcile({ summary, asOfLabel }: {
  summary: DailyReconcileSummary | null;
  asOfLabel?: string | null;
}) {
  if (!summary || summary.days.length === 0) return null;

  const hasPartial = summary.partialDayCount > 0;

  return (
    <Card className={hasPartial ? "border-amber-200 dark:border-amber-900" : undefined}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div>
            <p className="text-xs font-medium flex items-center gap-1.5">
              {hasPartial && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
              Console reconcile
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Always {summary.windowDays} closed days ({summary.from} → {summary.asOf}), not the 7/14/30/90 toggle
              {asOfLabel ? ` · as-of ${asOfLabel}` : ""}
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground max-w-sm">
            Seller Central totals span SP + SB + SD. Sales/orders use 14-day attribution
            (<code className="text-[9px]">sales_14d</code>).
          </p>
        </div>

        {hasPartial && (
          <p className="text-[10px] text-amber-700 dark:text-amber-400 mb-3">
            {summary.partialDayCount} day(s) look <span className="font-medium">SP-only</span>
            while other days in this window have Sponsored Brands or Display — console spend
            will read higher. Nightly sync at 05:00 re-pulls SB/SD for the last{" "}
            <span className="font-medium">{summary.sbSdRetryDays}</span> closed days, so a
            one-night timeout often self-heals. If a day stays partial for several nights, run{" "}
            <code>ads-sync --days 7 --campaigns-only</code> on Mini.
          </p>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px]">Date</TableHead>
              <TableHead className="text-[10px]">Products</TableHead>
              <TableHead className="text-[10px] text-right">Spend</TableHead>
              <TableHead className="text-[10px] text-right">Clicks</TableHead>
              <TableHead className="text-[10px] text-right">CTR</TableHead>
              <TableHead className="text-[10px] text-right">CPC</TableHead>
              <TableHead className="text-[10px] text-right">Sales 14d</TableHead>
              <TableHead className="text-[10px] text-right">Orders</TableHead>
              <TableHead className="text-[10px] text-right">ROAS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.days.map((d) => {
              const isAsOf = d.date === summary.asOf;
              return (
                <TableRow
                  key={d.date}
                  className={
                    d.partialSync
                      ? "bg-amber-50/60 dark:bg-amber-950/20"
                      : isAsOf
                        ? "bg-muted/40"
                        : undefined
                  }
                >
                  <TableCell className="text-xs font-medium tabular-nums">
                    {d.date}
                    {isAsOf && (
                      <span className="ml-1 text-[9px] text-muted-foreground">as-of</span>
                    )}
                    {d.partialSync && (
                      <span className="ml-1 text-[9px] text-amber-700 dark:text-amber-400">
                        partial
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {["SP", "SB", "SD"].map((t) => {
                        const present = d.productsPresent.includes(t);
                        const slice = d.byType[t];
                        return (
                          <Badge
                            key={t}
                            variant="outline"
                            className={`text-[9px] px-1 py-0 ${
                              present
                                ? TYPE_BADGE[t]
                                : "opacity-40 border-dashed"
                            }`}
                          >
                            {t}
                            {slice ? ` ${fmtD(slice.spend)}` : " —"}
                          </Badge>
                        );
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">${fmtD(d.spend)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{d.clicks}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {d.ctr != null ? `${d.ctr.toFixed(2)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {d.cpc != null ? `$${fmtD(d.cpc)}` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">${fmtD(d.sales)}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">{d.orders}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {d.roas != null ? d.roas.toFixed(2) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
