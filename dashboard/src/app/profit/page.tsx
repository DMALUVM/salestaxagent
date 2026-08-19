"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, DollarSign, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface PnlRow {
  date: string; gross_sales: number; units: number; ad_spend: number;
  est_referral_fees: number; est_fba_fees: number; est_cogs: number;
  est_contribution: number; amazon_net_proceeds: number | null;
  net_after_ads: number; status: string;
}

export default function ProfitPage() {
  const [data, setData] = useState<PnlRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/pnl").then((r) => r.json()).then((d) => {
      setData(d.daily ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const { last7, last30 } = useMemo(() => {
    const now = new Date();
    const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d7iso = d7.toISOString().slice(0, 10);
    const d30iso = d30.toISOString().slice(0, 10);

    const sum = (rows: PnlRow[], key: keyof PnlRow) =>
      rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

    const r7 = data.filter((r) => r.date >= d7iso);
    const r30 = data.filter((r) => r.date >= d30iso);

    return {
      last7: {
        sales: sum(r7, "gross_sales"),
        ads: sum(r7, "ad_spend"),
        referral: sum(r7, "est_referral_fees"),
        fba: sum(r7, "est_fba_fees"),
        cogs: sum(r7, "est_cogs"),
        contribution: sum(r7, "est_contribution"),
        net: sum(r7, "net_after_ads"),
        days: r7.length,
      },
      last30: {
        sales: sum(r30, "gross_sales"),
        ads: sum(r30, "ad_spend"),
        referral: sum(r30, "est_referral_fees"),
        fba: sum(r30, "est_fba_fees"),
        cogs: sum(r30, "est_cogs"),
        contribution: sum(r30, "est_contribution"),
        net: sum(r30, "net_after_ads"),
        days: r30.length,
      },
    };
  }, [data]);

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const hasData = data.length > 0;
  const margin7 = last7.sales > 0 ? (last7.net / last7.sales) * 100 : 0;
  const margin30 = last30.sales > 0 ? (last30.net / last30.sales) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Contribution P&L</h1>
        <p className="text-sm text-muted-foreground">
          Amazon payout minus COGS minus ad spend = your margin
        </p>
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="py-12 text-center">
            <DollarSign className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No P&L data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run: <code>python -m src.main pnl-sync --days 90</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card className={last7.net > 0 ? "border-emerald-500/30" : "border-red-500/30"}>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Contribution (7d)</p>
                <p className={`text-2xl font-semibold tabular-nums ${last7.net >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  ${fmtD(last7.net)}
                </p>
                <p className="text-xs text-muted-foreground">{margin7.toFixed(1)}% margin</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Gross Sales (7d)</p>
                <p className="text-2xl font-semibold tabular-nums">${fmt(Math.round(last7.sales))}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Ad Spend (7d)</p>
                <p className="text-2xl font-semibold tabular-nums">${fmtD(last7.ads)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Contribution (30d)</p>
                <p className={`text-2xl font-semibold tabular-nums ${last30.net >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  ${fmtD(last30.net)}
                </p>
                <p className="text-xs text-muted-foreground">{margin30.toFixed(1)}% margin</p>
              </CardContent>
            </Card>
          </div>

          {/* Waterfall breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">30-Day Contribution Waterfall</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                {[
                  { label: "Gross Sales", value: last30.sales, color: "" },
                  { label: "− Amazon Fees (referral + FBA)", value: -last30.referral - last30.fba, color: "text-red-500" },
                  { label: "= Amazon Payout", value: last30.sales - last30.referral - last30.fba, color: "font-medium" },
                  { label: "− COGS", value: -last30.cogs, color: "text-red-500" },
                  { label: "− Ad Spend", value: -last30.ads, color: "text-red-500" },
                  { label: "= Contribution", value: last30.net, color: last30.net >= 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold" },
                ].map((item) => (
                  <div key={item.label} className="flex justify-between">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className={`tabular-nums ${item.color}`}>${fmtD(Math.abs(item.value))}</span>
                  </div>
                ))}
              </div>
              {last30.cogs === 0 && (
                <div className="mt-3 flex items-center gap-2 text-xs text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  COGS not configured — set unit costs in sku_costs table for full picture
                </div>
              )}
            </CardContent>
          </Card>

          {/* Daily table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Daily P&L</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Sales</TableHead>
                    <TableHead className="text-right">Ads</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right font-semibold">Contribution</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.slice(0, 30).map((r) => {
                    const fees = Number(r.est_referral_fees ?? 0) + Number(r.est_fba_fees ?? 0) + Number(r.est_cogs ?? 0);
                    return (
                      <TableRow key={r.date}>
                        <TableCell className="text-xs tabular-nums">{r.date}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(r.gross_sales)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(r.ad_spend)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(fees)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-medium ${r.net_after_ads >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                          ${fmtD(r.net_after_ads)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] ${r.status === "reconciled" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                            {r.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              Amazon Payout = charges − fees − refunds (from Finances API, posted-date basis, may lag 1-3 days).
              Contribution = Payout − COGS − Ad Spend. Preliminary rows use estimated fees.
              Reconciled rows use actual Amazon data. Set COGS in sku_costs table.
              Compare to Seller Central → Payments → Date Range Report. Not accounting advice.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
