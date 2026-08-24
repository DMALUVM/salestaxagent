"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { SectionNav } from "@/components/section-nav";
import { ShopifyCustomers } from "@/components/shopify-customers";
import { PnlTable } from "@/components/pnl-table";
import { AdsMonthlyUpload } from "@/components/ads-monthly-upload";
import { isConfigured } from "@/lib/supabase";
import type { PnlRow } from "@/lib/pnl-periods";
import type { MonthlySkuLine } from "@/lib/sku-monthly-pnl";
import { Shield, DollarSign, AlertTriangle } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default function ProfitPage() {
  const [data, setData] = useState<PnlRow[]>([]);
  const [monthly, setMonthly] = useState<PnlRow[]>([]);
  const [monthlySkus, setMonthlySkus] = useState<Record<string, MonthlySkuLine[]>>({});
  const [skuCoverageMin, setSkuCoverageMin] = useState<string | null>(null);
  const [skuCoverageMax, setSkuCoverageMax] = useState<string | null>(null);
  const [skuMissingJan2024, setSkuMissingJan2024] = useState(false);
  const [adsDateMax, setAdsDateMax] = useState<string | null>(null);
  const [adsDateMin, setAdsDateMin] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [todayLA, setTodayLA] = useState<string | null>(null);
  const [latestClosed, setLatestClosed] = useState<string | null>(null);
  const [adsLagging, setAdsLagging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function loadPnl() {
    setLoading(true);
    setError(null);
    fetch("/api/pnl")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(String(d.error));
          setLoading(false);
          return;
        }
        setData(d.daily ?? []);
        setMonthly(d.monthly ?? []);
        setMonthlySkus(d.monthlySkus ?? {});
        setSkuCoverageMin(d.skuCoverageMin ?? null);
        setSkuCoverageMax(d.skuCoverageMax ?? null);
        setSkuMissingJan2024(Boolean(d.skuMissingJan2024));
        setAdsDateMax(d.adsDateMax ?? null);
        setAdsDateMin(d.adsDateMin ?? null);
        setAsOf(d.asOf ?? null);
        setTodayLA(d.today ?? null);
        setLatestClosed(d.latestClosed ?? null);
        setAdsLagging(Boolean(d.adsLagging));
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    loadPnl();
  }, []);

  const { latestDay, last7, last30, mtd } = useMemo(() => {
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

    if (!asOf) {
      const empty = win([]);
      return { latestDay: empty, last7: empty, last30: empty, mtd: empty };
    }

    // Every window is [start .. asOf] inclusive and ends at yesterday-in-LA.
    // Today is never included: it is still accruing sales and has no ad spend.
    const shift = (iso: string, n: number) => {
      const d = new Date(`${iso}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const closed = (from: string) =>
      data.filter((r) => r.date >= from && r.date <= asOf);

    return {
      latestDay: win(data.filter((r) => r.date === (latestClosed ?? asOf))),
      last7: win(closed(shift(asOf, -6))),    // 7 closed days ending as-of
      last30: win(closed(shift(asOf, -29))),  // 30 closed days ending as-of
      mtd: win(closed(`${asOf.slice(0, 7)}-01`)),
    };
  }, [data, asOf, latestClosed]);

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;
  if (error) return <QueryError message={error} onRetry={loadPnl} />;

  const hasData = data.length > 0 || monthly.length > 0;
  const margin7 = last7.sales > 0 ? (last7.net / last7.sales) * 100 : 0;
  const margin30 = last30.sales > 0 ? (last30.net / last30.sales) * 100 : 0;
  const avgDay = (w: { net: number; days: number }) => (w.days > 0 ? w.net / w.days : 0);
  // Today is excluded from every KPI, so a partial today is no longer a
  // warning. The only thing still worth flagging is ad spend lagging behind
  // as-of, which would understate cost inside the closed windows.
  const latestClosedDate = latestClosed ?? asOf;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Contribution P&L</h1>
        <p className="text-sm text-muted-foreground">
          Daily operating net = gross sales − referral − FBA − ad spend − COGS
        </p>
      </div>

      <SectionNav
        items={[
          { id: "customers", label: "Customer LTV" },
          { id: "windows", label: "Windows" },
          { id: "waterfall", label: "Waterfall" },
          { id: "daily", label: "P&L table" },
        ]}
      />

      {/* Customer economics sits ABOVE the daily P&L, not below it.
          At the bottom it started at the 91% mark of the page — present, but
          only findable by scrolling past everything else, which is why it read
          as "missing in production". Shopify only; the card states why Amazon
          cannot have person-level metrics rather than leaving that unexplained. */}
      <div id="customers" className="scroll-mt-14">
        <ShopifyCustomers />
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="py-12 text-center">
            <DollarSign className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No P&L data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Monthly SKU economics comes from <code>sales_by_sku</code>. Run{" "}
              <code>python -m src.main backfill-amazon-skus</code> if that table is empty.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            As of <span className="font-medium text-foreground">{asOf}</span> — yesterday in
            America/Los_Angeles, the Amazon reporting day. Today ({todayLA}) is still accruing and is
            excluded from every figure below.
            {adsLagging && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                Ad spend is only synced through {adsDateMax}, so days after that count $0 ads.
              </span>
            )}
          </p>

          {data.length > 0 && (
          <>
          {/* Net profit by window — all four from the same stored formula */}
          <div id="windows" className="scroll-mt-14 grid gap-3 grid-cols-2 sm:grid-cols-4">
            {[
              { label: "Net (latest closed day)", w: latestDay, sub: latestClosedDate ?? "" },
              { label: "Net (7d)", w: last7, sub: `${last7.days}d · $${fmtD(avgDay(last7))}/day · ${margin7.toFixed(1)}%` },
              { label: "Net (30d)", w: last30, sub: `${last30.days}d · $${fmtD(avgDay(last30))}/day · ${margin30.toFixed(1)}%` },
              { label: "Net (MTD)", w: mtd, sub: `${mtd.days} day${mtd.days === 1 ? "" : "s"} · $${fmtD(avgDay(mtd))}/day` },
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
          <Card id="waterfall" className="scroll-mt-14">
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
          </>
          )}

          <AdsMonthlyUpload onComplete={loadPnl} />

          <PnlTable
            rows={data}
            monthly={monthly}
            monthlySkus={monthlySkus}
            asOf={asOf}
            skuCoverageMin={skuCoverageMin}
            skuCoverageMax={skuCoverageMax}
            skuMissingJan2024={skuMissingJan2024}
            adsDateMin={adsDateMin}
          />

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              <strong>Contribution (operating net) = gross sales − referral − FBA − ad spend − COGS</strong>,
              stored per Amazon day (America/Los_Angeles order date) when daily rows exist.
              Month and year use Amazon SKU economics from <code>sales_by_sku</code> × <code>sku_costs</code>
              (Aug 2024 onward today). Gross sales come from the SP-API
              orders report (all non-cancelled statuses); ad spend from <code>ads_campaigns_daily</code>
              when that month has campaign rows, otherwise ads are labelled unknown;
              COGS from units × <code>sku_costs</code> per SKU. Fees are labelled
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
