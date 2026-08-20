"use client";

import { useEffect, useMemo, useState } from "react";
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
import { buildLast30Series } from "@/lib/overview-series";
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

/** Format YoY %: "+22% YoY", "−5% YoY", or "n/a" when null. */
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

type ChFilter = "all" | "shopify" | "amazon";

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
// Sales bucket aggregator
// ---------------------------------------------------------------------------

interface SalesBucket {
  shopify: number;
  amazon: number;
  total: number;
  shopifyOrders: number;
  amazonOrders: number;
  totalOrders: number;
}

function emptyBucket(): SalesBucket {
  return { shopify: 0, amazon: 0, total: 0, shopifyOrders: 0, amazonOrders: 0, totalOrders: 0 };
}

function yoyPct(cur: number, prev: number, hasPrev: boolean): number | null {
  if (!hasPrev || prev <= 0) return null;
  return ((cur / prev) - 1) * 100;
}

// ---------------------------------------------------------------------------

export default function Pulse() {
  const configured = isConfigured();
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

  // B2: Job health
  const [jobRuns, setJobRuns] = useState<Array<{ job_name: string; status: string; started_at: string; message: string | null }>>([]);
  useEffect(() => {
    if (!configured) return;
    fetch("/api/job-runs").then((r) => r.json()).then((d) => {
      if (d.runs) setJobRuns(d.runs);
    }).catch(() => {});
  }, [configured]);
  const { data: stateRules } = useSupabaseQuery<StateRule>("state_rules");
  const { data: salesByState } = useSupabaseQuery<SalesByState>("sales_by_state");

  const [channelFilter, setChannelFilter] = useState<ChFilter>("all");
  /** Hovered/focused index in the 30-day chart, or null. */
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const todayStr = localDate(new Date());

  // ── Sales aggregation ──
  const sales = useMemo(() => {
    const now = new Date();
    const yd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yesterday = localDate(yd);

    // YoY dates: same weekday last year (- 364 days)
    const yoyYd = localDate(new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 364));

    // Window boundaries (inclusive, ending on yesterday)
    const l7Start = localDate(new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 6));
    const l30Start = localDate(new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 29));

    // YoY windows (same weekday alignment)
    const yoyL7Start = localDate(new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 364 - 6));
    const yoyL7End = yoyYd;
    const yoyL30Start = localDate(new Date(yd.getFullYear(), yd.getMonth(), yd.getDate() - 364 - 29));
    const yoyL30End = yoyYd;

    // MTD
    const mtdStart = yesterday.slice(0, 8) + "01";
    const mtdMonthName = yd.toLocaleString(undefined, { month: "long" });

    // Last month
    const lmEnd = new Date(yd.getFullYear(), yd.getMonth(), 0); // last day of prev month
    const lmStart = localDate(new Date(lmEnd.getFullYear(), lmEnd.getMonth(), 1));
    const lmEndStr = localDate(lmEnd);
    const lmName = lmEnd.toLocaleString(undefined, { month: "long" });

    // Buckets
    const bYd = emptyBucket();
    const bL7 = emptyBucket();
    const bL30 = emptyBucket();
    const bMtd = emptyBucket();
    const bLm = emptyBucket();
    const bYoyYd = emptyBucket();
    const bYoyL7 = emptyBucket();
    const bYoyL30 = emptyBucket();

    function addToBucket(b: SalesBucket, ch: string, gross: number, orders: number) {
      if (ch === SHOPIFY) { b.shopify += gross; b.shopifyOrders += orders; }
      else if (ch === AMAZON) { b.amazon += gross; b.amazonOrders += orders; }
      b.total += gross;
      b.totalOrders += orders;
    }

    for (const row of salesDaily) {
      const ch = normalizeChannel(row.channel);
      const d = row.sale_date;
      const g = Number(row.gross_sales);
      const o = Number(row.order_count);

      if (d === yesterday) addToBucket(bYd, ch, g, o);
      if (d >= l7Start && d <= yesterday) addToBucket(bL7, ch, g, o);
      if (d >= l30Start && d <= yesterday) addToBucket(bL30, ch, g, o);
      if (d >= mtdStart && d <= yesterday) addToBucket(bMtd, ch, g, o);
      if (d >= lmStart && d <= lmEndStr) addToBucket(bLm, ch, g, o);

      // YoY
      if (d === yoyYd) addToBucket(bYoyYd, ch, g, o);
      if (d >= yoyL7Start && d <= yoyL7End) addToBucket(bYoyL7, ch, g, o);
      if (d >= yoyL30Start && d <= yoyL30End) addToBucket(bYoyL30, ch, g, o);
    }

    const hasYdData = salesDaily.some((r) => r.sale_date === yesterday);
    const hasYoyYd = salesDaily.some((r) => r.sale_date === yoyYd);
    const hasYoyL7 = salesDaily.some((r) => r.sale_date >= yoyL7Start && r.sale_date <= yoyL7End);
    const hasYoyL30 = salesDaily.some((r) => r.sale_date >= yoyL30Start && r.sale_date <= yoyL30End);

    // 30-day chart data — built by the pure, unit-tested series builder so the
    // window, date contiguity and channel bucketing stay pinned by tests
    // (src/lib/overview-series.test.ts).
    const last30 = buildLast30Series(salesDaily, now);

    // Data freshness
    let maxShopifyDate = "", maxAmazonDate = "";
    for (const row of salesDaily) {
      const ch = normalizeChannel(row.channel);
      if (ch === SHOPIFY && row.sale_date > maxShopifyDate) maxShopifyDate = row.sale_date;
      if (ch === AMAZON && row.sale_date > maxAmazonDate) maxAmazonDate = row.sale_date;
    }
    const nowMs = Date.now();
    const isStale = (ds: string) => !ds || (nowMs - new Date(ds + "T23:59:59").getTime()) > 36 * 3600 * 1000;

    return {
      yesterday, mtdMonthName, lmName, hasYdData,
      bYd, bL7, bL30, bMtd, bLm,
      bYoyYd, bYoyL7, bYoyL30,
      hasYoyYd, hasYoyL7, hasYoyL30,
      last30,
      maxShopifyDate, maxAmazonDate,
      shopifyStale: isStale(maxShopifyDate),
      amazonStale: isStale(maxAmazonDate),
    };
  }, [salesDaily, todayStr]);

  // ── Actions ──
  const recs = useMemo(
    () => buildRecommendations(stateRules ?? [], nexus ?? [], salesByState ?? [], (flags ?? []) as unknown as Array<{ state_code: string; [key: string]: unknown }>),
    [stateRules, nexus, salesByState, flags],
  );

  const { overdue, actionCount, nextFiling, nextFilingDays, criticalItems } = useMemo(() => {
    // Registration date lookup — exclude pre-registration periods from overdue
    const regDateMap = new Map<string, string>();
    for (const n of (nexus ?? [])) {
      if (n.registration_date) regDateMap.set(n.state_code, n.registration_date);
    }
    function isPostRegistration(f: { state_code: string; period_end?: string; due_date: string }) {
      const regDate = regDateMap.get(f.state_code);
      if (!regDate) return true;
      return (f.period_end ?? f.due_date) >= regDate;
    }

    const validPending = (filings ?? []).filter(
      (f) => (f.status === "pending" || f.status === "late") && isPostRegistration(f),
    );
    const od = validPending.filter((f) => f.due_date < todayStr);
    const regNow = recs.filter((r) => r.recommendation === "REGISTER_NOW");
    const ac = od.length + regNow.length;
    const nf = validPending.find((f) => f.due_date >= todayStr);
    const nfDays = nf ? Math.ceil((new Date(nf.due_date).getTime() - Date.now()) / 86400000) : null;

    const items: { label: string; href: string }[] = [];
    for (const r of regNow.slice(0, 3)) {
      const reason = r.has_economic_nexus ? "economic crossed" : r.fba_present ? "T1 FBA + direct" : "home/3PL";
      items.push({ label: `${r.state_code} — register (${reason})`, href: "/registrations" });
    }
    if (od.length > 0) items.push({ label: `${od.length} overdue filing${od.length > 1 ? "s" : ""}`, href: "/liability" });
    // Due-soon filings (next 14 days)
    const dueSoon = validPending.filter((f) => {
      const days = Math.ceil((new Date(f.due_date).getTime() - Date.now()) / 86400000);
      return days >= 0 && days <= 14;
    });
    if (dueSoon.length > 0 && od.length === 0) {
      items.push({ label: `${dueSoon.length} filing${dueSoon.length > 1 ? "s" : ""} due within 14d`, href: "/liability" });
    }
    for (const r of recs.filter((r) => r.recommendation === "REVIEW").slice(0, 2))
      items.push({ label: `${r.state_code} — review with CPA`, href: "/registrations" });

    return { overdue: od, actionCount: ac, nextFiling: nf, nextFilingDays: nfDays, criticalItems: items };
  }, [filings, recs, todayStr]);

  if (!configured) return <SetupPrompt />;
  if (l1 || l2 || l3) return <LoadingState />;

  // ── Channel-filtered accessor ──
  function pick(b: SalesBucket): { gross: number; orders: number } {
    if (channelFilter === "shopify") return { gross: b.shopify, orders: b.shopifyOrders };
    if (channelFilter === "amazon") return { gross: b.amazon, orders: b.amazonOrders };
    return { gross: b.total, orders: b.totalOrders };
  }

  function pickYoY(cur: SalesBucket, prev: SalesBucket, hasPrev: boolean): number | null {
    const c = pick(cur).gross;
    const p = pick(prev).gross;
    return yoyPct(c, p, hasPrev);
  }

  const yd = pick(sales.bYd);
  const l7 = pick(sales.bL7);
  const l30 = pick(sales.bL30);
  const mtd = pick(sales.bMtd);
  const lm = pick(sales.bLm);
  const ydYoy = pickYoY(sales.bYd, sales.bYoyYd, sales.hasYoyYd);
  const l7Yoy = pickYoY(sales.bL7, sales.bYoyL7, sales.hasYoyL7);
  const l30Yoy = pickYoY(sales.bL30, sales.bYoyL30, sales.hasYoyL30);

  const upcoming = (filings ?? []).filter((f) => f.status === "pending" && f.due_date >= todayStr).slice(0, 4);
  const chartMax = Math.max(...sales.last30.map((d) => d.shopify + d.amazon), 1);

  return (
    <div className="space-y-6">
      {/* Header + channel toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pulse</h1>
          <p className="text-sm text-muted-foreground">Daily command center</p>
        </div>
        <div className="flex gap-1">
          {(["all", "amazon", "shopify"] as ChFilter[]).map((ch) => (
            <button key={ch} onClick={() => setChannelFilter(ch)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                channelFilter === ch
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}>
              {ch === "all" ? "All" : ch === "amazon" ? "Amazon" : "Shopify"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sales pulse: Yesterday / L7 / L30 / MTD / Last Month ── */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {/* Yesterday */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Yesterday</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {sales.hasYdData ? `$${fmt(Math.round(yd.gross))}` : "\u2014"}
            </p>
            <p className="text-xs text-muted-foreground">
              {fmt(yd.orders)} orders
              {sales.hasYdData && (
                <span className={`ml-1.5 font-medium ${yoyColor(ydYoy)}`}>{fmtYoY(ydYoy)}</span>
              )}
            </p>
            {channelFilter === "all" && sales.hasYdData && (
              <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                Amz ${fmt(Math.round(sales.bYd.amazon))} · Shop ${fmt(Math.round(sales.bYd.shopify))}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Last 7 Days */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last 7 Days</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">${fmt(Math.round(l7.gross))}</p>
            <p className="text-xs text-muted-foreground">
              {fmt(l7.orders)} orders
              <span className={`ml-1.5 font-medium ${yoyColor(l7Yoy)}`}>{fmtYoY(l7Yoy)}</span>
            </p>
            {channelFilter === "all" && (
              <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                Amz ${fmt(Math.round(sales.bL7.amazon))} · Shop ${fmt(Math.round(sales.bL7.shopify))}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Last 30 Days */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last 30 Days</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">${fmt(Math.round(l30.gross))}</p>
            <p className="text-xs text-muted-foreground">
              {fmt(l30.orders)} orders
              <span className={`ml-1.5 font-medium ${yoyColor(l30Yoy)}`}>{fmtYoY(l30Yoy)}</span>
            </p>
            {channelFilter === "all" && (
              <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                Amz ${fmt(Math.round(sales.bL30.amazon))} · Shop ${fmt(Math.round(sales.bL30.shopify))}
              </p>
            )}
          </CardContent>
        </Card>

        {/* MTD */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">MTD</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">${fmt(Math.round(mtd.gross))}</p>
            <p className="text-xs text-muted-foreground">{sales.mtdMonthName} · {fmt(mtd.orders)} orders</p>
          </CardContent>
        </Card>

        {/* Last Month */}
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last Month</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">${fmt(Math.round(lm.gross))}</p>
            <p className="text-xs text-muted-foreground">{sales.lmName} · {fmt(lm.orders)} orders</p>
          </CardContent>
        </Card>
      </div>

      {/* ── 30-Day Chart ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Last 30 Days{sales.last30.some((d) => d.shopify + d.amazon > 0) ? "" : " — no data"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <div className="flex gap-px" style={{ height: "160px" }}>
              {sales.last30.map((day, i) => {
                const total = day.total;
                const barH = chartMax > 0 ? (total / chartMax) * 160 : 0;
                const shopifyH = total > 0 ? (day.shopify / total) * barH : 0;
                const amazonH = barH - shopifyH;
                const active = hoverDay === i;
                return (
                  <div
                    key={day.date}
                    // Hover target is the whole column, not just the painted
                    // bar, so short and empty days are reachable too.
                    className={`flex-1 flex flex-col justify-end min-w-0 cursor-default ${active ? "bg-muted/60" : ""}`}
                    onMouseEnter={() => setHoverDay(i)}
                    onMouseLeave={() => setHoverDay((h) => (h === i ? null : h))}
                    onFocus={() => setHoverDay(i)}
                    onBlur={() => setHoverDay((h) => (h === i ? null : h))}
                    tabIndex={0}
                    aria-label={`${day.date}: Shopify $${fmt(Math.round(day.shopify))}, Amazon $${fmt(Math.round(day.amazon))}`}
                  >
                    {amazonH > 0 && <div className="w-full rounded-t-sm bg-orange-400" style={{ height: `${amazonH}px` }} />}
                    {shopifyH > 0 && <div className={`w-full bg-blue-500 ${amazonH <= 0 ? "rounded-t-sm" : ""}`} style={{ height: `${shopifyH}px` }} />}
                    {/* A day with no row at all is a gap, not a $0 result: draw
                        a hatched placeholder instead of a stub bar that reads
                        as a genuinely terrible day. */}
                    {barH === 0 && !day.hasData && (
                      <div className="w-full rounded-t-sm border-t border-dashed border-muted-foreground/50" style={{ height: "6px" }} />
                    )}
                    {barH === 0 && day.hasData && (
                      <div className="w-full bg-muted" style={{ height: "1px" }} />
                    )}
                  </div>
                );
              })}
            </div>
            {hoverDay !== null && sales.last30[hoverDay] && (
              <div
                className="pointer-events-none absolute z-10 w-44 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                style={{
                  left: `${((hoverDay + 0.5) / sales.last30.length) * 100}%`,
                  top: 0,
                  transform: hoverDay > sales.last30.length / 2
                    ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
                }}
              >
                <p className="mb-1 text-[11px] font-medium">{sales.last30[hoverDay].date}</p>
                {[
                  { label: "Amazon", value: sales.last30[hoverDay].amazon, dot: "bg-orange-400" },
                  { label: "Shopify", value: sales.last30[hoverDay].shopify, dot: "bg-blue-500" },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-2 text-[11px] leading-5">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className={`inline-block h-0.5 w-2.5 rounded-full ${r.dot}`} />
                      {r.label}
                    </span>
                    <span className="tabular-nums font-medium">${fmt(Math.round(r.value))}</span>
                  </div>
                ))}
                <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1 text-[11px]">
                  <span className="text-muted-foreground">Total</span>
                  <span className="tabular-nums font-semibold">${fmt(Math.round(sales.last30[hoverDay].total))}</span>
                </div>
                {!sales.last30[hoverDay].hasData && (
                  <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                    No sales_daily row for this date — data gap, not a $0 day.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>30d ago</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-blue-500" /> Shopify</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-orange-400" /> Amazon</span>
            </span>
            <span>today</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Tax: Actions + Filing + Next Deadlines ── */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Card className={actionCount > 0 ? "border-amber-500/40" : ""}>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Actions</p>
            <Link href={overdue.length > 0 ? "/liability" : "/registrations"}>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${actionCount > 0 ? "text-amber-500" : ""}`}>{actionCount}</p>
              <p className="text-xs text-muted-foreground">
                {overdue.length > 0 ? `${overdue.length} overdue` : actionCount > 0 ? "Needs attention" : "All clear"}
              </p>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Next Filing</p>
            {nextFiling ? (
              <Link href="/filings" className="block">
                <p className="mt-1 text-2xl font-semibold tabular-nums">{nextFiling.state_code}</p>
                <p className="text-xs text-muted-foreground">{nextFilingDays}d &middot; {nextFiling.due_date.slice(5)}</p>
              </Link>
            ) : (
              <p className="mt-1 text-2xl font-semibold tabular-nums text-muted-foreground">None due</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Registered</p>
            <Link href="/registrations">
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {(nexus ?? []).filter((n) => isRegistered(n)).length}
              </p>
              <p className="text-xs text-muted-foreground">states</p>
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Nexus States</p>
            <Link href="/nexus">
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {(nexus ?? []).filter((n) => n.has_physical_nexus || n.has_economic_nexus).length}
              </p>
              <p className="text-xs text-muted-foreground">physical + economic</p>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* ── Top Actions + Next Deadlines ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Top Actions
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" /> Next Deadlines
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
                      <span className="font-medium text-red-700 dark:text-red-300">OVERDUE — {f.state_code} {f.period_label}</span>
                      <span className="text-xs text-red-600 dark:text-red-400">{f.due_date}</span>
                    </div>
                  </Link>
                ))}
                {upcoming.filter((_, i) => i < 4 - Math.min(overdue.length, 2)).map((f) => {
                  const days = Math.ceil((new Date(f.due_date).getTime() - Date.now()) / 86400000);
                  return (
                    <div key={f.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>{f.state_code} <span className="text-muted-foreground">{f.period_label}</span></span>
                      <span className={`text-xs font-medium ${days <= 7 ? "text-red-500" : days <= 14 ? "text-amber-500" : "text-muted-foreground"}`}>
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

      {/* ── Data + job health ── */}
      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-4">
              <span>Shopify: <span className={sales.shopifyStale ? "text-amber-500 font-medium" : ""}>{sales.maxShopifyDate || "never"}</span></span>
              <span>&middot;</span>
              <span>Amazon: <span className={sales.amazonStale ? "text-amber-500 font-medium" : ""}>{sales.maxAmazonDate || "never"}</span></span>
              {(sales.shopifyStale || sales.amazonStale) && <span className="text-amber-500">Data may be stale (&gt;36h)</span>}
            </div>
            <Link href="/data" className="text-xs font-medium text-primary hover:underline">Data &amp; Export</Link>
          </div>
        </CardContent>
      </Card>

      {/* B2: Job health */}
      {jobRuns.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Automation Health</CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="flex flex-wrap gap-3">
              {jobRuns.map((j) => {
                const ago = Math.round((Date.now() - new Date(j.started_at).getTime()) / 3600000);
                const agoStr = ago < 1 ? "<1h" : ago < 24 ? `${ago}h` : `${Math.round(ago / 24)}d`;
                return (
                  <div key={j.job_name} className="flex items-center gap-1.5 text-xs" title={j.message || ""}>
                    <span className={`h-2 w-2 rounded-full ${j.status === "success" ? "bg-emerald-500" : j.status === "fail" ? "bg-red-500" : "bg-amber-500"}`} />
                    <span className="text-muted-foreground">{j.job_name.replace(/_/g, " ")}</span>
                    <span className="tabular-nums text-muted-foreground/60">{agoStr}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* P0-5: Trust surface */}
      <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
        <span>
          This is a monitoring and research aid, not legal or tax advice.
          Sales channels: Shopify (seller-responsible) and Amazon (marketplace-remitted, reference only).
          Tax rates are state-level approximations; local surcharges may apply.
          Amazon Custom Combined Tax data is quarantined from calculations.
          Consult a qualified CPA before acting on any position.
        </span>
      </div>
    </div>
  );
}
