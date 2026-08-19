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
  /** "settled" when Amazon has posted actual fees, else "estimated". */
  fees_basis?: string;
}

export default function ProfitPage() {
  const [data, setData] = useState<PnlRow[]>([]);
  const [adsDateMax, setAdsDateMax] = useState<string | null>(null);
  const [salesDateMax, setSalesDateMax] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/pnl").then((r) => r.json()).then((d) => {
      setData(d.daily ?? []);
      setAdsDateMax(d.adsDateMax ?? null);
      setSalesDateMax(d.salesDateMax ?? null);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const { today, last7, last30, mtd } = useMemo(() => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const minus = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
    const d7iso = minus(7);
    const d30iso = minus(30);
    // Month to date, on the same calendar the daily rows are keyed by.
    const mtdStart = `${iso(now).slice(0, 7)}-01`;

    const sum = (rows: PnlRow[], key: keyof PnlRow) =>
      rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

    /** Window totals straight from the stored per-day figures. */
    const win = (rows: PnlRow[]) => ({
      sales: sum(rows, "gross_sales"),
      units: sum(rows, "units"),
      ads: sum(rows, "ad_spend"),
      referral: sum(rows, "est_referral_fees"),
      fba: sum(rows, "est_fba_fees"),
      cogs: sum(rows, "est_cogs"),
      // contribution is stored per day; summing it is the same as applying the
      // formula to the window, and keeps the UI from re-deriving anything.
      net: sum(rows, "net_after_ads"),
      payout: sum(rows, "amazon_net_proceeds"),
      days: rows.length,
    });

    return {
      today: win(data.slice(0, 1)),
      last7: win(data.filter((r) => r.date >= d7iso)),
      last30: win(data.filter((r) => r.date >= d30iso)),
      mtd: win(data.filter((r) => r.date >= mtdStart)),
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
  // Ads sync runs through yesterday while sales land same-day, so the newest
  // day(s) can carry sales with no ad spend yet — contribution reads high there.
  const adsBehind = Boolean(adsDateMax && salesDateMax && adsDateMax < salesDateMax);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Contribution P&L</h1>
        <p className="text-sm text-muted-foreground">
          Daily operating net = gross sales − referral − FBA − ad spend − COGS
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
          {adsBehind && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span>
                Partial ad data: sales run through {salesDateMax} but ad spend only through {adsDateMax}.
                Days after {adsDateMax} count $0 ad spend, so their contribution reads high until the next Ads sync.
              </span>
            </div>
          )}

          {/* Net profit by window — all four from the same stored formula */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            {[
              { label: "Net (latest day)", w: today, sub: data[0]?.date ?? "" },
              { label: "Net (7d)", w: last7, sub: `${margin7.toFixed(1)}% margin` },
              { label: "Net (30d)", w: last30, sub: `${margin30.toFixed(1)}% margin` },
              { label: "Net (MTD)", w: mtd, sub: `${mtd.days} day${mtd.days === 1 ? "" : "s"}` },
            ].map((c) => (
              <Card key={c.label} className={c.w.net >= 0 ? "border-emerald-500/30" : "border-red-500/30"}>
                <CardContent className="p-4">
                  <p className="text-[10px] text-muted-foreground uppercase">{c.label}</p>
                  <p className={`text-2xl font-semibold tabular-nums ${c.w.net >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                    ${fmtD(c.w.net)}
                  </p>
                  <p className="text-xs text-muted-foreground">{c.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Inputs for the 7-day window */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            {[
              { label: "Gross Sales (7d)", value: last7.sales },
              { label: "Fees (7d)", value: last7.referral + last7.fba },
              { label: "Ad Spend (7d)", value: last7.ads },
              { label: "COGS (7d)", value: last7.cogs },
            ].map((c) => (
              <Card key={c.label}>
                <CardContent className="p-4">
                  <p className="text-[10px] text-muted-foreground uppercase">{c.label}</p>
                  <p className="text-2xl font-semibold tabular-nums">${fmt(Math.round(c.value))}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Waterfall breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                30-Day Contribution Waterfall
                {/* pnl_daily may hold fewer days than the window — say so
                    rather than let 8 days read as a month. */}
                <span className="ml-2 font-normal text-muted-foreground">
                  {last30.days} day{last30.days === 1 ? "" : "s"} with P&amp;L data
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                {[
                  { label: "Gross Sales", value: last30.sales, color: "" },
                  { label: "− Referral fees", value: -last30.referral, color: "text-red-500" },
                  { label: "− FBA fees", value: -last30.fba, color: "text-red-500" },
                  { label: "− Ad Spend", value: -last30.ads, color: "text-red-500" },
                  { label: "− COGS", value: -last30.cogs, color: "text-red-500" },
                  { label: "= Contribution (operating net)", value: last30.net, color: last30.net >= 0 ? "text-emerald-600 font-semibold" : "text-red-600 font-semibold" },
                ].map((item) => (
                  <div key={item.label} className="flex justify-between">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className={`tabular-nums ${item.color}`}>${fmtD(Math.abs(item.value))}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-2 text-xs">
                  <span className="text-muted-foreground">
                    Amazon deposits over these days (settlement, ~2×/month)
                  </span>
                  <span className="tabular-nums text-muted-foreground">${fmtD(last30.payout)}</span>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Contribution is stored per Amazon day (America/Los_Angeles) as
                <code className="mx-1">gross_sales − referral − fba − ad_spend − cogs</code>
                and summed for each window. Ad spend comes from <code>ads_campaigns_daily</code>,
                the same source as the PPC page; COGS is daily units × <code>sku_costs</code> per SKU.
                Amazon pays out roughly twice a month on a settlement (posted-date) basis — that
                deposit is the cash truth to reconcile against, not a daily margin.
              </p>
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
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right">Ads</TableHead>
                    <TableHead className="text-right">COGS</TableHead>
                    <TableHead className="text-right font-semibold">Contribution</TableHead>
                    <TableHead>Fees basis</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.slice(0, 35).map((r) => {
                    // Fees only — COGS is its own column now, not folded in here.
                    const fees = Number(r.est_referral_fees ?? 0) + Number(r.est_fba_fees ?? 0);
                    return (
                      <TableRow key={r.date}>
                        <TableCell className="text-xs tabular-nums">{r.date}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(r.gross_sales)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(r.units)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(fees)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(r.ad_spend)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(r.est_cogs)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-medium ${r.net_after_ads >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                          ${fmtD(r.net_after_ads)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] ${r.fees_basis === "settled" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                            {r.fees_basis ?? "estimated"}
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
              <strong>Contribution (operating net) = gross sales − referral − FBA − ad spend − COGS</strong>,
              stored per Amazon day (America/Los_Angeles order date). Gross sales come from the SP-API
              orders report (all non-cancelled statuses); ad spend from <code>ads_campaigns_daily</code>;
              COGS from daily units × <code>sku_costs</code> per SKU. Fees are labelled
              &ldquo;estimated&rdquo; (referral % + per-unit FBA) or &ldquo;settled&rdquo; (actual Amazon fees).
              Amazon deposits roughly twice a month on a settlement/posted-date basis — that deposit is
              the cash truth to reconcile against, and is shown separately rather than used as a daily
              margin. Compare to Seller Central → Payments → Date Range Report. Not accounting advice.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
