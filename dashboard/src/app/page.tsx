"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSupabaseQuery, useSalesDaily } from "@/lib/hooks";
import { isRegistered } from "@/lib/compliance-status";
import { buildRecommendations } from "@/lib/registration-model";
import type {
  NexusStatus,
  FilingEntry,
  FranchiseTaxFlag,
  SalesDaily,
  SalesByState,
  IngestionLog,
  StateRule,
} from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isConfigured } from "@/lib/supabase";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  Shield,
} from "lucide-react";

// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** YYYY-MM-DD in local time (not UTC — avoids timezone shift bugs). */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format YoY %: "+22% YoY", "−5% YoY", or "n/a" when null. Never shows 0% as missing. */
function fmtYoY(pct: number | null): string {
  if (pct === null) return "n/a";
  const sign = pct >= 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(Math.round(pct))}% YoY`;
}

function yoyColor(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct > 0) return "text-emerald-600 dark:text-emerald-400";
  if (pct < 0) return "text-red-500 dark:text-red-400";
  return "text-muted-foreground";
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function OwnerHQ() {
  if (!isConfigured()) return <SetupPrompt />;

  const { data: salesDaily, loading: l1 } = useSalesDaily<SalesDaily>();
  const { data: nexus, loading: l2 } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: filings, loading: l3 } = useSupabaseQuery<FilingEntry>("filing_calendar", {
    orderBy: "due_date",
    ascending: true,
  });
  const { data: flags } = useSupabaseQuery<FranchiseTaxFlag>("franchise_tax_flags", {
    filters: { status: "open" },
  });
  const { data: logs } = useSupabaseQuery<IngestionLog>("ingestion_log", {
    orderBy: "ingested_at",
    limit: 10,
  });
  const { data: stateRules } = useSupabaseQuery<StateRule>("state_rules");
  const { data: salesByState } = useSupabaseQuery<SalesByState>("sales_by_state");

  // ── Date boundaries (local time, not UTC) ──
  const todayStr = localDate(new Date());

  const computed = useMemo(() => {
    const now = new Date();

    // yesterday = today - 1 day (local)
    const yd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yesterday = localDate(yd);

    // yoyDate = yesterday - 52 weeks / 364 days (same weekday last year)
    const yoy = new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 364);
    const yoyDate = localDate(yoy);

    // mtdStart = first of yesterday's month
    const mtdStart = yesterday.slice(0, 8) + "01";

    // Month name for subtitle
    const mtdMonthName = yd.toLocaleString(undefined, { month: "long" });

    // ── Aggregate sales_daily ──
    let ydShopify = 0,
      ydAmazon = 0,
      mtdShopify = 0,
      mtdAmazon = 0,
      yoyShopify = 0,
      yoyAmazon = 0;
    let ydShopifyOrders = 0,
      ydAmazonOrders = 0;

    for (const row of salesDaily) {
      const ch = normalizeChannel(row.channel);
      if (row.sale_date === yesterday) {
        if (ch === SHOPIFY) {
          ydShopify += Number(row.gross_sales);
          ydShopifyOrders += Number(row.order_count);
        } else if (ch === AMAZON) {
          ydAmazon += Number(row.gross_sales);
          ydAmazonOrders += Number(row.order_count);
        }
      }
      if (row.sale_date >= mtdStart && row.sale_date <= yesterday) {
        if (ch === SHOPIFY) mtdShopify += Number(row.gross_sales);
        else if (ch === AMAZON) mtdAmazon += Number(row.gross_sales);
      }
      if (row.sale_date === yoyDate) {
        if (ch === SHOPIFY) yoyShopify += Number(row.gross_sales);
        else if (ch === AMAZON) yoyAmazon += Number(row.gross_sales);
      }
    }

    const ydTotal = ydShopify + ydAmazon;
    const yoyTotal = yoyShopify + yoyAmazon;
    const hasYoyData = salesDaily.some((r) => r.sale_date === yoyDate);
    const yoyPct = hasYoyData && yoyTotal > 0 ? ((ydTotal / yoyTotal) - 1) * 100 : null;
    const yoyShopifyPct = hasYoyData && yoyShopify > 0 ? ((ydShopify / yoyShopify) - 1) * 100 : null;
    const yoyAmazonPct = hasYoyData && yoyAmazon > 0 ? ((ydAmazon / yoyAmazon) - 1) * 100 : null;
    const mtdTotal = mtdShopify + mtdAmazon;
    const hasYdData = salesDaily.some((r) => r.sale_date === yesterday);

    // ── 30-day chart data ──
    // Build a lookup map first (O(n) instead of O(n*30))
    const dailyMap = new Map<string, { shopify: number; amazon: number }>();
    for (const row of salesDaily) {
      const key = row.sale_date;
      const ch = normalizeChannel(row.channel);
      let entry = dailyMap.get(key);
      if (!entry) {
        entry = { shopify: 0, amazon: 0 };
        dailyMap.set(key, entry);
      }
      if (ch === SHOPIFY) entry.shopify += Number(row.gross_sales);
      else if (ch === AMAZON) entry.amazon += Number(row.gross_sales);
    }

    const last30: { date: string; shopify: number; amazon: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1 - i);
      const ds = localDate(d);
      const entry = dailyMap.get(ds);
      last30.push({
        date: ds,
        shopify: entry?.shopify ?? 0,
        amazon: entry?.amazon ?? 0,
      });
    }

    // ── Data freshness ──
    let maxShopifyDate = "";
    let maxAmazonDate = "";
    for (const row of salesDaily) {
      const ch = normalizeChannel(row.channel);
      if (ch === SHOPIFY && row.sale_date > maxShopifyDate) maxShopifyDate = row.sale_date;
      if (ch === AMAZON && row.sale_date > maxAmazonDate) maxAmazonDate = row.sale_date;
    }

    const nowMs = Date.now();
    const isStale = (dateStr: string) => {
      if (!dateStr) return true;
      const ms = nowMs - new Date(dateStr + "T23:59:59").getTime();
      return ms > 36 * 3600 * 1000;
    };
    const shopifyStale = isStale(maxShopifyDate);
    const amazonStale = isStale(maxAmazonDate);

    return {
      yesterday,
      ydShopify,
      ydAmazon,
      ydTotal,
      ydShopifyOrders,
      ydAmazonOrders,
      mtdTotal,
      mtdMonthName,
      yoyPct,
      yoyShopifyPct,
      yoyAmazonPct,
      hasYdData,
      last30,
      maxShopifyDate,
      maxAmazonDate,
      shopifyStale,
      amazonStale,
    };
  }, [salesDaily, todayStr]);

  // ── Actions (shared model — must be before any early return) ──
  const recs = useMemo(
    () => buildRecommendations(stateRules ?? [], nexus ?? [], salesByState ?? [], flags ?? []),
    [stateRules, nexus, salesByState, flags],
  );

  const { overdue, registerNowCount, actionCount, nextFiling, nextFilingDays, criticalItems } = useMemo(() => {
    const od = (filings ?? []).filter(
      (f) => (f.status === "pending" || f.status === "late") && f.due_date < todayStr,
    );
    const regNow = recs.filter((r) => r.recommendation === "REGISTER_NOW");
    const regNowCount = regNow.length;
    const ac = od.length + regNowCount;

    const nf = (filings ?? []).find(
      (f) => f.status === "pending" && f.due_date >= todayStr,
    );
    const nfDays = nf
      ? Math.ceil((new Date(nf.due_date).getTime() - Date.now()) / 86400000)
      : null;

    const items: { label: string; href: string }[] = [];
    for (const r of regNow.slice(0, 3)) {
      const reason = r.has_economic_nexus ? "economic crossed" : r.fba_present ? "T1 FBA + direct" : "home/3PL";
      items.push({ label: `${r.state_code} — register (${reason})`, href: "/registrations" });
    }
    if (od.length > 0)
      items.push({ label: `${od.length} overdue filing${od.length > 1 ? "s" : ""}`, href: "/filings" });
    for (const r of recs.filter((r) => r.recommendation === "REVIEW").slice(0, 2))
      items.push({ label: `${r.state_code} — review with CPA`, href: "/registrations" });

    return {
      overdue: od,
      registerNowCount: regNowCount,
      actionCount: ac,
      nextFiling: nf,
      nextFilingDays: nfDays,
      criticalItems: items,
    };
  }, [filings, recs, todayStr]);

  if (l1 || l2 || l3) return <LoadingState />;

  // ── Upcoming deadlines ──
  const upcoming = filings
    .filter((f) => f.status === "pending" && f.due_date >= todayStr)
    .slice(0, 4);

  // ── Chart max ──
  const chartMax = Math.max(...computed.last30.map((d) => d.shopify + d.amazon), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Owner HQ</h1>
        <p className="text-sm text-muted-foreground">Daily command center</p>
      </div>

      {/* ── Hero strip: 6 stat cards ── */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {/* 1. Yesterday */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Yesterday
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {computed.hasYdData ? `$${fmt(Math.round(computed.ydTotal))}` : "\u2014"}
            </p>
            <p className={`text-xs font-medium ${computed.hasYdData ? yoyColor(computed.yoyPct) : "text-muted-foreground"}`}>
              {computed.hasYdData ? fmtYoY(computed.yoyPct) : "No daily data"}
            </p>
          </CardContent>
        </Card>

        {/* 2. Shopify */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Shopify
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(computed.ydShopify))}
            </p>
            <p className="text-xs text-muted-foreground">
              {fmt(computed.ydShopifyOrders)} orders
              {computed.hasYdData && (
                <span className={`ml-1.5 font-medium ${yoyColor(computed.yoyShopifyPct)}`}>
                  {fmtYoY(computed.yoyShopifyPct)}
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* 3. Amazon */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Amazon
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(computed.ydAmazon))}
            </p>
            <p className="text-xs text-muted-foreground">
              {fmt(computed.ydAmazonOrders)} orders
              {computed.hasYdData && (
                <span className={`ml-1.5 font-medium ${yoyColor(computed.yoyAmazonPct)}`}>
                  {fmtYoY(computed.yoyAmazonPct)}
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* 4. MTD */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              MTD
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(computed.mtdTotal))}
            </p>
            <p className="text-xs text-muted-foreground">
              {computed.mtdMonthName}
            </p>
          </CardContent>
        </Card>

        {/* 5. Next Filing */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Next Filing
            </p>
            {nextFiling ? (
              <Link href="/filings" className="block">
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {nextFiling.state_code}
                </p>
                <p className="text-xs text-muted-foreground">
                  {nextFilingDays}d &middot; {nextFiling.due_date.slice(5)}
                </p>
              </Link>
            ) : (
              <>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-muted-foreground">
                  None due
                </p>
                <p className="text-xs text-muted-foreground">&nbsp;</p>
              </>
            )}
          </CardContent>
        </Card>

        {/* 6. Actions */}
        <Card className={actionCount > 0 ? "border-amber-500/40" : ""}>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Actions
            </p>
            <Link href={overdue.length > 0 ? "/filings" : "/registrations"}>
              <p
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  actionCount > 0 ? "text-amber-500" : ""
                }`}
              >
                {actionCount}
              </p>
              <p className="text-xs text-muted-foreground">
                {overdue.length > 0
                  ? `${overdue.length} overdue`
                  : actionCount > 0
                    ? "Needs attention"
                    : "All clear"}
              </p>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* ── 30-Day Chart ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Last 30 Days
            {computed.last30.some((d) => d.shopify + d.amazon > 0) ? "" : " — no data"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-px" style={{ height: "160px" }}>
            {computed.last30.map((day) => {
              const total = day.shopify + day.amazon;
              const barH = chartMax > 0 ? (total / chartMax) * 160 : 0;
              const shopifyH = total > 0 ? (day.shopify / total) * barH : 0;
              const amazonH = barH - shopifyH;
              return (
                <div
                  key={day.date}
                  className="flex-1 flex flex-col justify-end min-w-0"
                  title={`${day.date}\nShopify: $${fmt(Math.round(day.shopify))}\nAmazon: $${fmt(Math.round(day.amazon))}\nTotal: $${fmt(Math.round(total))}`}
                >
                  {amazonH > 0 && (
                    <div
                      className="w-full rounded-t-sm bg-orange-400"
                      style={{ height: `${amazonH}px` }}
                    />
                  )}
                  {shopifyH > 0 && (
                    <div
                      className={`w-full bg-blue-500 ${amazonH <= 0 ? "rounded-t-sm" : ""}`}
                      style={{ height: `${shopifyH}px` }}
                    />
                  )}
                  {barH === 0 && (
                    <div className="w-full bg-muted" style={{ height: "1px" }} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>30d ago</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-blue-500" /> Shopify
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-orange-400" /> Amazon
              </span>
            </span>
            <span>today</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Top Actions + Next Deadlines ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top Actions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Top Actions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {criticalItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">All clear.</p>
            ) : (
              <div className="space-y-2">
                {criticalItems.slice(0, 5).map((item, i) => (
                  <Link key={i} href={item.href}>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted">
                      <span>{item.label}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Next Deadlines */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Next Deadlines
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 && overdue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming deadlines.</p>
            ) : (
              <div className="space-y-2">
                {overdue.slice(0, 2).map((f) => (
                  <Link key={f.id} href="/filings">
                    <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950">
                      <span className="font-medium text-red-700 dark:text-red-300">
                        OVERDUE — {f.state_code} {f.period_label}
                      </span>
                      <span className="text-xs text-red-600 dark:text-red-400">
                        {f.due_date}
                      </span>
                    </div>
                  </Link>
                ))}
                {upcoming
                  .filter((_, i) => i < 4 - Math.min(overdue.length, 2))
                  .map((f) => {
                    const days = Math.ceil(
                      (new Date(f.due_date).getTime() - Date.now()) / 86400000,
                    );
                    return (
                      <div
                        key={f.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                      >
                        <span>
                          {f.state_code}{" "}
                          <span className="text-muted-foreground">{f.period_label}</span>
                        </span>
                        <span
                          className={`text-xs font-medium ${
                            days <= 7
                              ? "text-red-500"
                              : days <= 14
                                ? "text-amber-500"
                                : "text-muted-foreground"
                          }`}
                        >
                          {days}d &middot; {f.due_date.slice(5)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Data health footer ── */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap gap-4">
            <span>
              Shopify:{" "}
              <span className={computed.shopifyStale ? "text-amber-500 font-medium" : ""}>
                {computed.maxShopifyDate || "never"}
              </span>
            </span>
            <span>&middot;</span>
            <span>
              Amazon:{" "}
              <span className={computed.amazonStale ? "text-amber-500 font-medium" : ""}>
                {computed.maxAmazonDate || "never"}
              </span>
            </span>
            {(computed.shopifyStale || computed.amazonStale) && (
              <span className="text-amber-500">Data may be stale (&gt;36h)</span>
            )}
          </div>
          <Link href="/data" className="text-xs font-medium text-primary hover:underline">
            Data &amp; Export
          </Link>
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground/60">
        Monitoring aid — not legal or tax advice.
      </p>
    </div>
  );
}
