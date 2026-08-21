"use client";

import { useEffect, useMemo, useState, Fragment } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { ShopifyCustomers } from "@/components/shopify-customers";
import { isConfigured } from "@/lib/supabase";
import { Shield, DollarSign, AlertTriangle, ChevronRight } from "lucide-react";

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
  const [asOf, setAsOf] = useState<string | null>(null);
  const [todayLA, setTodayLA] = useState<string | null>(null);
  const [latestClosed, setLatestClosed] = useState<string | null>(null);
  const [adsLagging, setAdsLagging] = useState(false);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/pnl").then((r) => r.json()).then((d) => {
      setData(d.daily ?? []);
      setAdsDateMax(d.adsDateMax ?? null);
      setAsOf(d.asOf ?? null);
      setTodayLA(d.today ?? null);
      setLatestClosed(d.latestClosed ?? null);
      setAdsLagging(Boolean(d.adsLagging));
      setLoading(false);
    }).catch(() => setLoading(false));
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

  const hasData = data.length > 0;
  const margin7 = last7.sales > 0 ? (last7.net / last7.sales) * 100 : 0;
  const margin30 = last30.sales > 0 ? (last30.net / last30.sales) * 100 : 0;
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

          {/* Net profit by window — all four from the same stored formula */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            {[
              { label: "Net (latest closed day)", w: latestDay, sub: latestClosedDate ?? "" },
              { label: "Net (7d)", w: last7, sub: `${last7.days}d · ${margin7.toFixed(1)}% margin` },
              { label: "Net (30d)", w: last30, sub: `${last30.days}d · ${margin30.toFixed(1)}% margin` },
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
                    // Anything after as-of is still open; shown for visibility
                    // but excluded from every aggregate above.
                    const open = Boolean(asOf && r.date > asOf);
                    const isOpenRow = expandedDate === r.date;
                    return (
                      <Fragment key={r.date}>
                        <TableRow
                          className={`cursor-pointer ${open ? "opacity-60" : ""}`}
                          onClick={() => setExpandedDate(isOpenRow ? null : r.date)}
                        >
                          <TableCell className="text-xs tabular-nums">
                            <span className="flex items-center gap-1.5">
                              <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${isOpenRow ? "rotate-90" : ""}`} />
                              {r.date}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">${fmtD(r.gross_sales)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(r.units)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(fees)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(r.ad_spend)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(r.est_cogs)}</TableCell>
                          <TableCell className={`text-right tabular-nums font-medium ${r.net_after_ads >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                            ${fmtD(r.net_after_ads)}
                          </TableCell>
                          <TableCell>
                            {open ? (
                              <Badge variant="outline" className="text-[9px] bg-muted text-muted-foreground">
                                preliminary · excluded
                              </Badge>
                            ) : (
                              <Badge variant="outline" className={`text-[9px] ${r.fees_basis === "settled" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                                {r.fees_basis ?? "estimated"}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                        {isOpenRow && (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={8} className="py-3">
                              <DayDetail date={r.date} row={r} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
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

      {/* Customer economics. Shopify only — the card states why Amazon cannot
          have person-level metrics rather than leaving the absence unexplained.
          Loads on demand: it aggregates every stored order. */}
      <ShopifyCustomers />
    </div>
  );
}


/* ── Day drill-down ──────────────────────────────────────────────
 * Read-only view of one Amazon day: the same waterfall the row shows, the
 * SKU rows behind it, and the campaigns that made up the ad spend. Every
 * figure is read from pnl_daily / ads_campaigns_daily — nothing is
 * recomputed, so the panel cannot disagree with the row above it.
 * ---------------------------------------------------------------- */

interface SkuLine {
  sku: string; gross_sales: number; units: number; ad_spend: number;
  est_referral_fees: number; est_fba_fees: number; est_cogs: number;
  est_contribution: number;
}
interface CampaignLine { campaign_name: string; spend: number; sales: number }
interface DayData {
  date: string;
  skus: SkuLine[];
  campaigns: CampaignLine[];
  adSpendTotal: number;
  feesBasis: string;
  cogsBasis: string | null;
  settledPayout: number | null;
}

function DayDetail({ date, row }: { date: string; row: PnlRow }) {
  const [day, setDay] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pnl/day?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(String(d.error));
        else setDay(d);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [date]);

  const fees = Number(row.est_referral_fees ?? 0) + Number(row.est_fba_fees ?? 0);
  const skus = (day?.skus ?? []).filter((s) => s.sku !== "__unallocated__");
  const topSkus = [...skus].sort((a, b) => b.est_contribution - a.est_contribution).slice(0, 8);

  return (
    <div className="grid gap-6 whitespace-normal lg:grid-cols-3">
      {/* Waterfall — must reconcile to the row's contribution */}
      <div>
        <p className="mb-2 text-xs font-medium">Day waterfall</p>
        <div className="space-y-1 text-xs">
          {[
            { label: "Gross sales", value: Number(row.gross_sales ?? 0), color: "" },
            { label: "− Referral fees", value: -Number(row.est_referral_fees ?? 0), color: "text-red-500" },
            { label: "− FBA fees", value: -Number(row.est_fba_fees ?? 0), color: "text-red-500" },
            { label: "− Ad spend", value: -Number(row.ad_spend ?? 0), color: "text-red-500" },
            { label: "− COGS", value: -Number(row.est_cogs ?? 0), color: "text-red-500" },
            { label: "= Contribution", value: Number(row.net_after_ads ?? 0), color: Number(row.net_after_ads ?? 0) >= 0 ? "font-semibold text-emerald-600" : "font-semibold text-red-600" },
          ].map((l) => (
            <div key={l.label} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{l.label}</span>
              <span className={`tabular-nums ${l.color}`}>${fmtD(Math.abs(l.value))}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {fees > 0 && `Fees ${day?.feesBasis ?? row.fees_basis ?? "estimated"}. `}
          {day?.cogsBasis === "sku_units_x_sku_costs"
            ? "COGS = daily units × sku_costs."
            : "COGS estimated from order-count units."}
          {day?.settledPayout != null && ` Settlement posted this day: $${fmtD(day.settledPayout)} (cash, not margin).`}
        </p>
      </div>

      {/* Top SKUs for the day */}
      <div>
        <p className="mb-2 text-xs font-medium">
          Top SKUs by contribution
          {skus.length > 0 && <span className="ml-1 font-normal text-muted-foreground">({skus.length} with sales)</span>}
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!error && !day && <p className="text-xs text-muted-foreground">Loading…</p>}
        {day && topSkus.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No SKU-grain rows for this day — run <code>pnl-sync</code> to store them.
          </p>
        )}
        {topSkus.length > 0 && (
          <div className="space-y-1 text-xs">
            {topSkus.map((s) => (
              <div key={s.sku} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground" title={s.sku}>{s.sku}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {fmt(s.units)}u · ${fmtD(s.est_cogs)} COGS
                </span>
                <span className={`shrink-0 tabular-nums font-medium ${s.est_contribution >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  ${fmtD(s.est_contribution)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ad spend behind the day */}
      <div>
        <p className="mb-2 text-xs font-medium">Ad spend</p>
        <p className="text-xs text-muted-foreground">
          Account total <span className="tabular-nums font-medium text-foreground">${fmtD(row.ad_spend)}</span>
          {" "}— campaign-level, so it is not attributed to a SKU above.
        </p>
        {day && day.campaigns.length > 0 && (
          <div className="mt-2 space-y-1 text-xs">
            {day.campaigns.slice(0, 6).map((c) => (
              <div key={c.campaign_name} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground" title={c.campaign_name}>{c.campaign_name}</span>
                <span className="shrink-0 tabular-nums">${fmtD(c.spend)}</span>
              </div>
            ))}
            {day.campaigns.length > 6 && (
              <p className="text-[10px] text-muted-foreground">
                +{day.campaigns.length - 6} more campaigns
              </p>
            )}
          </div>
        )}
        {day && day.campaigns.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">No campaign rows for this date.</p>
        )}
      </div>
    </div>
  );
}
