"use client";

import { useMemo, useState } from "react";
import { useInventory } from "@/lib/hooks";
import type {
  InventorySnapshot,
  SkuVelocity,
  InventoryRestock,
  InventorySettings,
  SeasonalityWeekly,
  Inventory3plSnapshot,
} from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import {
  Shield,
  AlertTriangle,
  Download,
  Package,
  ShoppingBag,
  Settings,
  Play,
} from "lucide-react";
import Link from "next/link";
import { displayTitle, rawTitle } from "@/lib/display-title";

// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_URL
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_ANON_KEY
        </code>
        .
      </p>
    </div>
  );
}

const FLAG_COLORS: Record<string, string> = {
  CRITICAL:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  LOW: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  OK: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  OVERSTOCK:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
};

interface ComputedRow {
  sku: string;
  asin: string;
  product_name: string;
  fulfillable: number;
  fba_on_hand: number;
  inbound: number;
  reserved: number;
  tpl_available: number;
  awd_on_hand: number;
  on_hand: number;
  amazon_u_7: number;
  amazon_u_30: number;
  shopify_u_7: number;
  shopify_u_30: number;
  total_u_7: number;
  total_u_30: number;
  planning_u_30: number;
  holiday_surge_mult: number;
  shopify_share_pct: number;
  channel: string;
  dos: number;
  dos_amz_supply: number;
  pipeline_dos: number;
  our_reorder_qty: number;
  amz_rec_qty: number;
  amz_rec_ship: string | null;
  stockout_date: string | null;
  network_oos_date: string | null;
  flag: string;
}

// ---------------------------------------------------------------------------

export default function InventoryPage() {
  const { data: raw, loading, error, refetch } = useInventory();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ComputedRow | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);

  // Persisted preferences
  const PREFS_KEY = "inventory-table-prefs";
  function loadPrefs() {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "null"); } catch { return null; }
  }
  const saved = loadPrefs();
  const [sortCol, setSortCol] = useState<string>(saved?.sortColumn ?? "fba_on_hand");
  const [sortAsc, setSortAsc] = useState<boolean>(saved?.sortDir === "asc");
  const [showZeroStock, setShowZeroStock] = useState<boolean>(saved?.hideZeroStock === false);
  const [filterChip, setFilterChip] = useState<string | null>(saved?.activeFilter ?? null);

  function savePrefs(col: string, asc: boolean, zero: boolean, chip: string | null) {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        sortColumn: col, sortDir: asc ? "asc" : "desc",
        hideZeroStock: !zero, activeFilter: chip,
      }));
    } catch { /* quota */ }
  }
  function handleSort(col: string) {
    const newAsc = sortCol === col ? !sortAsc : col === "sku";
    setSortCol(col); setSortAsc(newAsc);
    savePrefs(col, newAsc, showZeroStock, filterChip);
  }
  function handleSetZero(v: boolean) { setShowZeroStock(v); savePrefs(sortCol, sortAsc, v, filterChip); }
  function handleSetChip(v: string | null) { setFilterChip(v); savePrefs(sortCol, sortAsc, showZeroStock, v); }

  // Parse raw API response
  const snapshots = (raw?.snapshots ?? []) as InventorySnapshot[];
  const velocities = (raw?.velocity ?? []) as SkuVelocity[];
  const restockList = (raw?.restock ?? []) as InventoryRestock[];
  const tplSnapshots = (raw?.tpl ?? []) as Inventory3plSnapshot[];
  const settings = (raw?.settings ?? {
    target_cover_days: 60,
    lead_time_days: 35,
    holiday_mode: false,
    include_inbound: true,
    include_3pl: true,
    include_awd: true,
    receiving_days_normal: 14,
    receiving_days_peak: 28,
    awd_to_fba_days: 14,
    production_lead_days: 45,
    peak_start_date: null,
    peak_end_date: null,
  }) as InventorySettings;
  const seasonality = (raw?.seasonality ?? []) as SeasonalityWeekly[];
  const forecasts = (raw?.forecast ?? []) as { sku: string; week_start: string; scenario: string; units: number }[];
  const awdSnapshots = (raw?.awd ?? []) as { sku: string; awd_on_hand: number; awd_inbound: number }[];
  const modelStateRows = (raw?.modelState ?? []) as Array<{ sku: string; weights: unknown; seasonal_factors: unknown; model_version: string }>;
  const capacityLimits = (raw?.capacity ?? []) as { month: string; limit_ft3: number; used_ft3: number; source: string }[];

  const [localSettings, setLocalSettings] = useState<InventorySettings | null>(
    null,
  );
  const s = localSettings ?? settings;

  const rows = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const velMap = new Map(velocities.map((v) => [v.sku, v]));
    const recMap = new Map(restockList.map((r) => [r.sku, r]));
    const tplMap = new Map(tplSnapshots.map((t) => [t.sku, t]));
    const awdMap = new Map(awdSnapshots.map((a) => [a.sku, a]));

    const allSkus = new Set([
      ...snapshots.map((s) => s.sku),
      ...velocities.map((v) => v.sku),
      ...restockList.map((r) => r.sku),
      ...tplSnapshots.map((t) => t.sku),
      ...awdSnapshots.map((a) => a.sku),
    ]);

    // Seasonality: account curve + per-SKU peak floors from holiday surge
    const seasMap = new Map<number, number>();
    const skuSeasMap = new Map<string, Map<number, number>>();
    for (const sw of seasonality) {
      const skuKey = sw.sku ?? "_account_";
      if (skuKey === "_account_") {
        seasMap.set(sw.week, sw.multiplier);
      } else {
        if (!skuSeasMap.has(skuKey)) skuSeasMap.set(skuKey, new Map());
        skuSeasMap.get(skuKey)!.set(sw.week, sw.multiplier);
      }
    }

    // Forecast lookup: {sku: {YYYY-MM: monthly_units}}
    // Aggregate forecast_weekly (correction_factor) by month for demand override.
    // Also map 2026-01 → 2027-01 since forecast xlsx uses 2026 dates for
    // what is actually the following January's demand.
    const fcMonthly = new Map<string, Map<string, number>>();
    for (const f of forecasts) {
      if (f.scenario !== "correction_factor") continue;
      let m = f.week_start?.slice(0, 7);
      if (!m) continue;
      // Re-key 2026-01 as 2027-01 (January following the holiday season)
      if (m === "2026-01") m = "2027-01";
      if (!fcMonthly.has(f.sku)) fcMonthly.set(f.sku, new Map());
      const skuMap = fcMonthly.get(f.sku)!;
      skuMap.set(m, (skuMap.get(m) ?? 0) + Number(f.units));
    }

    function toYM(d: Date): string {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }

    function daysInMonthD(d: Date): number {
      return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    }

    // Peak weeks (Nov-Jan): ISO weeks 44-52 + 1-5
    const PEAK_WEEKS = new Set<number>();
    for (let w = 44; w <= 52; w++) PEAK_WEEKS.add(w);
    for (let w = 1; w <= 5; w++) PEAK_WEEKS.add(w);
    const PEAK_FLOOR = 0.85;

    // Load calibrated model weights per SKU
    type Weights = { a: number; b: number; c: number };
    const DEFAULT_OFFPEAK: Weights = { a: 0.15, b: 0.60, c: 0.25 };
    const DEFAULT_PEAK: Weights = { a: 0.10, b: 0.70, c: 0.20 };

    const skuModelWeights = new Map<string, { offpeak: Weights; peak: Weights }>();
    let globalOffpeak = DEFAULT_OFFPEAK;
    let globalPeak = DEFAULT_PEAK;
    for (const ms of modelStateRows) {
      let offpeak = DEFAULT_OFFPEAK;
      let peak = DEFAULT_PEAK;
      const w = typeof ms.weights === "string" ? JSON.parse(ms.weights) : ms.weights;
      if (w && typeof w.a === "number") offpeak = w as Weights;
      let sf = ms.seasonal_factors;
      if (typeof sf === "string") sf = JSON.parse(sf);
      if (sf && (sf as Record<string, unknown>).peak_weights) {
        const pw = (sf as Record<string, unknown>).peak_weights;
        if (pw && typeof (pw as Weights).a === "number") peak = pw as Weights;
      }
      if (ms.sku === "*") { globalOffpeak = offpeak; globalPeak = peak; }
      else { skuModelWeights.set(ms.sku, { offpeak, peak }); }
    }

    function getWeights(sku: string): { offpeak: Weights; peak: Weights } {
      return skuModelWeights.get(sku) ?? { offpeak: globalOffpeak, peak: globalPeak };
    }

    /**
     * Walk week-by-week using calibrated demand model:
     *   1. Three methods per week: naive, seasonal/forecast, SnS+organic
     *   2. Blend using peak or offpeak weights from forecast_model_state
     *   3. Holiday floor: peak weeks >= method_B × 85%
     * Returns the date when stock reaches 0.
     */
    function seasonalStockoutDate(
      stock: number, baseDailyRate: number, sku: string,
    ): string | null {
      if (baseDailyRate <= 0.001 && !fcMonthly.has(sku)) return stock > 0 ? null : null;
      if (stock <= 0) return new Date().toISOString().slice(0, 10);

      const now = new Date();
      const skuFc = fcMonthly.get(sku);
      const { offpeak, peak } = getWeights(sku);
      let remaining = stock;

      for (let wOffset = 0; wOffset < 104; wOffset++) {
        const weekDate = new Date(now);
        weekDate.setDate(weekDate.getDate() + wOffset * 7);

        const jan1 = new Date(weekDate.getFullYear(), 0, 1);
        const isoWeek = Math.max(1, Math.min(52, Math.ceil(
          ((weekDate.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7,
        )));
        const isPeak = PEAK_WEEKS.has(isoWeek);
        const wt = isPeak ? peak : offpeak;
        const acctMult = seasMap.get(isoWeek) ?? 1.0;
        const skuMult = skuSeasMap.get(sku)?.get(isoWeek);
        // Per-SKU holiday surge floor on peak weeks (lip balm >> account avg)
        const mult =
          skuMult != null && skuMult > acctMult ? skuMult : acctMult;

        // Method A: naive (flat velocity × 7)
        const naive = baseDailyRate * 7;

        // Method B: seasonal or forecast
        const ym = toYM(weekDate);
        const fcMonthUnits = skuFc?.get(ym);
        let seasonal: number;
        if (fcMonthUnits != null && fcMonthUnits > 0) {
          seasonal = (fcMonthUnits / daysInMonthD(weekDate)) * 7;
        } else {
          seasonal = baseDailyRate * 7 * mult;
        }

        // Method C: SnS floor + organic (simplified — use seasonal as proxy)
        const methodC = seasonal; // no per-SKU SnS in this context

        // Blend with calibrated weights
        let weekDemand = wt.a * naive + wt.b * seasonal + wt.c * methodC;

        // Holiday floor: peak weeks >= method_B × 85%
        if (isPeak && seasonal > 0) {
          weekDemand = Math.max(weekDemand, seasonal * PEAK_FLOOR);
        }

        if (weekDemand <= 0) continue;

        if (remaining <= weekDemand) {
          const frac = remaining / weekDemand;
          const outDate = new Date(weekDate);
          outDate.setDate(outDate.getDate() + Math.floor(frac * 7));
          return outDate.toISOString().slice(0, 10);
        }
        remaining -= weekDemand;
      }
      return null; // > 2 years out
    }

    const result: ComputedRow[] = [];
    const eps = 0.001;

    for (const sku of allSkus) {
      const snap = snapMap.get(sku);
      const vel = velMap.get(sku);
      const rec = recMap.get(sku);
      const tpl = tplMap.get(sku);
      const awdItem = awdMap.get(sku);

      const fulfillable = Number(snap?.fulfillable ?? 0);
      const reserved = Number(snap?.reserved ?? 0);
      const researching = Number(snap?.researching ?? 0);
      const unfulfillable_qty = Number(snap?.unfulfillable ?? 0);
      // FBA on-hand = fulfillable + reserved + researching + unfulfillable
      const fba_on_hand = fulfillable + reserved + researching + unfulfillable_qty;
      const inbound =
        Number(snap?.inbound_working ?? 0) +
        Number(snap?.inbound_shipped ?? 0) +
        Number(snap?.inbound_receiving ?? 0);
      const tpl_available = Number(tpl?.available ?? 0);
      const awd_on_hand = Number(awdItem?.awd_on_hand ?? 0);
      let on_hand = fba_on_hand + (s.include_inbound ? inbound : 0);
      if (s.include_3pl) on_hand += tpl_available;
      if (s.include_awd !== false) on_hand += awd_on_hand;

      const total_vel_30 = Number(vel?.total_u_30 ?? 0);
      const v90 = Number(vel?.total_u_90 ?? 0);
      const planning_vel_raw = Number(vel?.planning_u_30 ?? 0);
      const surge_mult = Number(vel?.holiday_surge_mult ?? 1);
      const summer_prior = Number(vel?.summer_prior_daily ?? 0);
      const holiday_prior = Number(vel?.holiday_prior_daily ?? 0);
      // Trough-resistant baseline: max(V30, V90, summer) — Aug/Sep V30 loses if depressed
      const troughBaseline = Math.max(total_vel_30, v90, summer_prior);
      let planning_vel = planning_vel_raw;
      if (surge_mult > 1.05 && holiday_prior > 0) {
        const yoy = Math.min(1.4, Math.max(0.75, troughBaseline / Math.max(summer_prior, 0.01)));
        const anchored = holiday_prior * yoy;
        planning_vel = Math.max(planning_vel_raw, troughBaseline, anchored);
      } else {
        planning_vel = Math.max(planning_vel_raw, troughBaseline);
      }
      const amazon_vel_30 = Number(vel?.amazon_u_30 ?? 0);
      const shopify_vel_30 = Number(vel?.shopify_u_30 ?? 0);

      // Channel detection
      const minVel = 0.1;
      const amazonActive = fba_on_hand > 0 || awd_on_hand > 0 || inbound > 0 || amazon_vel_30 > minVel;
      const shopifyOnly = !amazonActive && (shopify_vel_30 > minVel || tpl_available > 0);
      // Skip inactive/junk
      if (!amazonActive && !shopifyOnly && total_vel_30 <= minVel) continue;
      const channel = shopifyOnly ? "shopify_only" : "amazon";

      // Amazon FBA: always ≥60d at holiday-aware planning velocity
      const AMAZON_MIN_COVER = 60;
      const target = Math.max(
        AMAZON_MIN_COVER,
        s.holiday_mode ? Math.max(90, s.target_cover_days) : s.target_cover_days,
      );
      let dos: number, dos_amz_supply: number, pipeline_dos: number;
      let our_reorder: number, stockout_date: string | null = null, flag: string;

      let network_oos_date: string | null = null;

      if (shopifyOnly) {
        // Shopify-only: supply = 3PL, demand = Shopify velocity
        const demand = shopify_vel_30;
        const supply = tpl_available;
        dos = demand > eps ? supply / demand : (supply > 0 ? 9999 : 0);
        dos_amz_supply = dos;
        pipeline_dos = Math.round(dos);
        our_reorder = Math.max(Math.ceil((target + s.lead_time_days) * demand) - supply, 0);
        stockout_date = seasonalStockoutDate(supply, demand, sku);
        network_oos_date = stockout_date; // same pool for shop-only
        flag = dos < 30 && demand > eps ? "LOW" : our_reorder > 0 ? "RESTOCK" : "OK";
      } else {
        // Amazon: never use Aug/Sep trough V30 — planning_vel is holiday-aware
        const demand = planning_vel > eps ? planning_vel : total_vel_30;
        dos = demand > eps ? fba_on_hand / demand : (fba_on_hand > 0 ? 9999 : 0);
        const amz_supply = fba_on_hand + inbound + awd_on_hand;
        dos_amz_supply = demand > eps ? amz_supply / demand : (amz_supply > 0 ? 9999 : 0);
        const pipeline_supply = fba_on_hand + inbound + awd_on_hand;
        pipeline_dos = demand > eps ? Math.round(pipeline_supply / demand) : (pipeline_supply > 0 ? 9999 : 0);
        // Reorder to hit ≥60d (or holiday target) at planning velocity + lead time
        our_reorder = Math.max(Math.ceil((target + s.lead_time_days) * demand) - on_hand, 0);
        stockout_date = seasonalStockoutDate(fba_on_hand, demand, sku);
        const network = fba_on_hand + inbound + awd_on_hand + tpl_available;
        network_oos_date = seasonalStockoutDate(network, demand, sku);
        flag =
          dos < AMAZON_MIN_COVER && demand > eps
            ? "CRITICAL"
            : our_reorder > 0
              ? "RESTOCK"
              : "OK";
      }

      const shopify_share = total_vel_30 > 0 ? Math.round((shopify_vel_30 / total_vel_30) * 100) : 0;

      result.push({
        sku,
        asin: vel?.asin ?? rec?.asin ?? snap?.asin ?? "",
        product_name: vel?.product_name ?? rec?.product_name ?? snap?.product_name ?? tpl?.product_name ?? "",
        fulfillable,
        fba_on_hand,
        inbound,
        reserved,
        tpl_available,
        awd_on_hand,
        on_hand,
        amazon_u_7: Number(vel?.amazon_u_7 ?? 0),
        amazon_u_30: amazon_vel_30,
        shopify_u_7: Number(vel?.shopify_u_7 ?? 0),
        shopify_u_30: shopify_vel_30,
        total_u_7: Number(vel?.total_u_7 ?? 0),
        total_u_30: total_vel_30,
        planning_u_30: planning_vel,
        holiday_surge_mult: surge_mult,
        shopify_share_pct: shopify_share,
        channel,
        dos: Math.min(Math.round(dos), 9999),
        dos_amz_supply: Math.min(Math.round(dos_amz_supply), 9999),
        pipeline_dos: Math.min(pipeline_dos, 9999),
        our_reorder_qty: our_reorder,
        amz_rec_qty: rec?.recommended_qty ?? 0,
        amz_rec_ship: rec?.recommended_ship_date ?? null,
        stockout_date,
        network_oos_date,
        flag,
      });
    }

    return result;
  }, [snapshots, velocities, restockList, tplSnapshots, awdSnapshots, forecasts, seasonality, modelStateRows, s]);

  // Filter + sort
  const filtered = useMemo(() => {
    let list = rows;

    // Hide UNKNOWN
    list = list.filter((r) => r.sku !== "UNKNOW" && r.sku !== "UNKNOWN");

    // Hide zero-stock unless toggled
    if (!showZeroStock) {
      list = list.filter(
        (r) => r.fba_on_hand > 0 || r.awd_on_hand > 0 || r.tpl_available > 0 || r.inbound > 0 || r.total_u_30 > 0.1,
      );
    }

    // Filter chips
    if (filterChip === "critical") list = list.filter((r) => r.flag === "CRITICAL");
    else if (filterChip === "under60") list = list.filter((r) => r.dos < 60 && r.dos > 0);
    else if (filterChip === "inbound") list = list.filter((r) => r.inbound > 0);
    else if (filterChip === "awd") list = list.filter((r) => r.awd_on_hand > 0);
    else if (filterChip === "3pl") list = list.filter((r) => r.tpl_available > 0);

    // Text search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.sku.toLowerCase().includes(q) ||
          r.asin.toLowerCase().includes(q) ||
          r.product_name.toLowerCase().includes(q),
      );
    }

    // Sort
    const col = sortCol as keyof ComputedRow;
    list.sort((a, b) => {
      const av = a[col] ?? 0;
      const bv = b[col] ?? 0;
      if (typeof av === "number" && typeof bv === "number")
        return sortAsc ? av - bv : bv - av;
      return sortAsc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return list;
  }, [rows, search, sortCol, sortAsc, showZeroStock, filterChip]);

  // Summary
  const summary = useMemo(() => {
    const active = rows.filter(
      (r) => r.fulfillable > 0 || r.total_u_30 > 0,
    );
    const atRisk = active.filter((r) => r.dos < 60);
    const totalReorder = rows.reduce((s, r) => s + r.our_reorder_qty, 0);
    const totalAmzRec = rows.reduce((s, r) => s + r.amz_rec_qty, 0);
    const totalOnHand = rows.reduce((s, r) => s + r.on_hand, 0);
    const totalVel = rows.reduce((s, r) => s + r.total_u_30, 0);
    const weeksOfCover =
      totalVel > 0
        ? Math.round((totalOnHand / (totalVel * 7)) * 10) / 10
        : 0;
    return {
      active: active.length,
      atRisk: atRisk.length,
      totalReorder,
      totalAmzRec,
      weeksOfCover,
    };
  }, [rows]);

  async function saveSettings() {
    if (!localSettings) return;
    setSaving(true);
    try {
      await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSettings),
      });
      refetch();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
      setShowSettings(false);
    }
  }

  function exportCSV() {
    const header =
      "SKU,ASIN,Product,FBA_OnHand,AWD,3PL,Inbound,TotalV30,PlanningU30,Surge,DOS,Pipeline_DOS,Reorder,FBA_Out,Network_OOS,Flag\n";
    const body = filtered
      .map(
        (r) =>
          `"${r.sku}","${r.asin}","${displayTitle(r.product_name).replace(/"/g, '""')}",${r.fba_on_hand},${r.awd_on_hand},${r.tpl_available},${r.inbound},${r.total_u_30},${r.planning_u_30},${r.holiday_surge_mult},${r.dos},${r.pipeline_dos},${r.our_reorder_qty},${r.stockout_date ?? ""},${r.network_oos_date ?? ""},${r.flag}`,
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reorder_plan_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!isConfigured()) return <SetupPrompt />;
  if (loading) return <LoadingState />;

  const AMAZON_MIN_COVER = 60;
  const target = Math.max(
    AMAZON_MIN_COVER,
    s.holiday_mode ? Math.max(90, s.target_cover_days) : s.target_cover_days,
  );

  // Seasonality chart data (weeks 1-52) — account-level only
  const seasonChart = seasonality
    .filter((s) => (s.sku ?? "_account_") === "_account_" && Number(s.week) >= 1 && Number(s.week) <= 52)
    .map((s) => ({ ...s, week: Number(s.week), multiplier: Number(s.multiplier) }))
    .sort((a, b) => a.week - b.week);
  const maxMult = Math.max(...seasonChart.map((s) => s.multiplier), 1.5);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Target ≥{target}d Amazon FBA cover at holiday planning velocity
            {" "}&middot; {Number(s.receiving_days_normal)}–{Number(s.receiving_days_peak)}d check-in buffer
            {s.holiday_mode && (
              <Badge variant="outline" className="ml-2 text-amber-600 border-amber-300">Holiday Mode</Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Aug/Sep trough V30 is not used as baseline. Surge SKUs plan off 2025 Nov–Dec × YoY; Amazon floor is 60 days.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLocalSettings({ ...s });
              setShowSettings(true);
            }}
          >
            <Settings className="mr-1.5 h-3.5 w-3.5" />
            Settings
          </Button>
          <Link href="/inventory/plan">
            <Button variant="default" size="sm">
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Plan SKU
            </Button>
          </Link>
          <Link href="/inventory/returns">
            <Button variant="outline" size="sm">
              FBA Returns
            </Button>
          </Link>
          <Link href="/inventory/3pl">
            <Button variant="outline" size="sm">
              3PL Costs
            </Button>
          </Link>
          <Link href="/inventory/pallets">
            <Button variant="outline" size="sm">
              <Package className="mr-1.5 h-3.5 w-3.5" />
              Pallet Planner
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
        <Card className={summary.atRisk > 0 ? "border-amber-500/40" : ""}>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              FBA &lt;60d
            </p>
            <p
              className={`mt-1 text-2xl font-semibold tabular-nums ${
                summary.atRisk > 0 ? "text-amber-500" : ""
              }`}
            >
              {summary.atRisk}
            </p>
            <p className="text-xs text-muted-foreground">
              of {summary.active} active SKUs
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Our Reorder
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmt(summary.totalReorder)}
            </p>
            <p className="text-xs text-muted-foreground">units to order</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Amazon Rec
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmt(summary.totalAmzRec)}
            </p>
            <p className="text-xs text-muted-foreground">units recommended</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Portfolio Cover
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {summary.weeksOfCover}
            </p>
            <p className="text-xs text-muted-foreground">weeks of cover</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Active SKUs
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {summary.active}
            </p>
            <p className="text-xs text-muted-foreground">with stock or sales</p>
          </CardContent>
        </Card>
      </div>

      {/* Capacity strip */}
      {capacityLimits.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">FBA Capacity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {capacityLimits.map((c) => {
                const headroom = c.limit_ft3 - c.used_ft3;
                const pct = c.limit_ft3 > 0 ? Math.round((c.used_ft3 / c.limit_ft3) * 100) : 0;
                return (
                  <div key={c.month} className="text-center">
                    <p className="text-xs text-muted-foreground">{c.month}</p>
                    <div className="mt-1 h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {headroom.toFixed(1)} ft³ free
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {c.used_ft3.toFixed(1)}/{c.limit_ft3.toFixed(1)}
                      <span className="ml-1">({c.source === "confirmed" ? "✓" : "est"})</span>
                    </p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Seasonality chart */}
      {seasonChart.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Weekly Seasonality Index
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-px" style={{ height: "96px" }}>
              {seasonChart.map((s) => {
                const barH = maxMult > 0 ? (s.multiplier / maxMult) * 96 : 0;
                const isHoliday = s.week >= 40 && s.week <= 52;
                return (
                  <div
                    key={s.week}
                    className="flex-1 flex flex-col justify-end min-w-0"
                    title={`Week ${s.week}: ${s.multiplier.toFixed(2)}x`}
                  >
                    <div
                      className={`w-full rounded-t-sm ${
                        isHoliday ? "bg-amber-500" : "bg-blue-400"
                      }`}
                      style={{ height: `${barH}px` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>W1 (Jan)</span>
              <span className="flex gap-3">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm bg-blue-400" />{" "}
                  Normal
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />{" "}
                  Q4 Holiday
                </span>
              </span>
              <span>W52 (Dec)</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search + filters */}
      <div className="space-y-2">
        <input
          type="text"
          placeholder="Search SKU, ASIN, or product name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: null, label: "All" },
            { id: "critical", label: "CRITICAL" },
            { id: "under60", label: "Under 60d" },
            { id: "inbound", label: "Has inbound" },
            { id: "awd", label: "Has AWD" },
            { id: "3pl", label: "Has 3PL" },
          ].map((c) => (
            <button
              key={c.id ?? "all"}
              onClick={() => handleSetChip(c.id)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                filterChip === c.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          ))}
          <span className="mx-1 text-muted-foreground/30">|</span>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={showZeroStock} onChange={(e) => handleSetZero(e.target.checked)} />
            Zero-stock SKUs
          </label>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {filtered.length} SKUs shown
          </span>
        </div>
      </div>

      {/* SKU Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                {[
                  { key: "sku", label: "SKU", tip: "Seller SKU / MSKU" },
                  { key: "fba_on_hand", label: "FBA", tip: "Sellable units checked in at Amazon FBA" },
                  { key: "awd_on_hand", label: "AWD", tip: "AWD on-hand (not FBA sellable until replenished)" },
                  { key: "tpl_available", label: "3PL", tip: "Third-party / own warehouse units" },
                  { key: "inbound", label: "Inbnd", tip: "Amazon inbound — not yet sellable" },
                  { key: "total_u_7", label: "V7", tip: "Average daily units sold over last 7 days" },
                  { key: "total_u_30", label: "V30", tip: "Average daily units sold over last 30 days" },
                  { key: "planning_u_30", label: "Plan", tip: "Holiday planning velocity — trough-resistant baseline × surge / prior Nov–Dec × YoY. Used for Amazon DOS & reorder (not Aug/Sep V30)." },
                  { key: "holiday_surge_mult", label: "Surge", tip: "2025 Nov–Dec daily ÷ Jun–Aug daily. Lip balm often 2–4.5×; deodorant ~0.7–1×" },
                  { key: "dos", label: "DOS", tip: "FBA days of supply at planning velocity — must stay ≥60d" },
                  { key: "pipeline_dos", label: "+Pipe", tip: "Cover in days if FBA+AWD+Inbound all become sellable" },
                  { key: "amz_rec_qty", label: "AmzRec", tip: "Amazon recommended replenishment quantity" },
                  { key: "our_reorder_qty", label: "Reorder", tip: "Units to transfer/produce to reach target cover" },
                  { key: "stockout_date", label: "Out", tip: "FBA reaches 0 (Amazon) or warehouse reaches 0 (Shop) — uses forecast + seasonality" },
                  { key: "network_oos_date", label: "OOS", tip: "All network stock (FBA+AWD+3PL+Inbound) reaches 0 — uses forecast + seasonality" },
                  { key: "flag", label: "Status", tip: "OK ≥ target cover; CRITICAL/LOW below; RESTOCK approaching" },
                ].map(({ key, label, tip }) => (
                  <TableHead
                    key={key}
                    title={tip}
                    className={`cursor-pointer hover:text-foreground text-right whitespace-nowrap ${
                      key === "sku" ? "text-left sticky left-0 z-20 bg-card" : ""
                    }`}
                    onClick={() => handleSort(key)}
                  >
                    {label}
                    {sortCol === key && (
                      <span className="ml-0.5">
                        {sortAsc ? "\u25B2" : "\u25BC"}
                      </span>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                    <TableCell
                      colSpan={15}
                      className="text-center text-muted-foreground py-8"
                    >
                      No inventory data. Run:{" "}
                      <code className="text-xs bg-muted px-1 rounded">
                        inventory-sync
                      </code>{" "}
                      then{" "}
                      <code className="text-xs bg-muted px-1 rounded">
                        inventory-velocity
                      </code>{" "}
                      /{" "}
                      <code className="text-xs bg-muted px-1 rounded">
                        inventory-holiday-surge
                      </code>
                    </TableCell>
                </TableRow>
              ) : (
                filtered.map((r, i) => (
                  <TableRow
                    key={r.sku}
                    className={`cursor-pointer hover:bg-muted/50 ${
                      i % 2 === 1 ? "bg-muted/20" : ""
                    }`}
                    onClick={() => setSelected(r)}
                  >
                    <TableCell className="font-medium max-w-[180px] truncate sticky left-0 z-10 bg-card" title={r.product_name ? displayTitle(r.product_name) : r.sku}>
                      <a href={`/inventory/plan?sku=${encodeURIComponent(r.sku)}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                        {r.sku}
                      </a>
                      {r.channel === "shopify_only" ? (
                        <span className="ml-1.5 text-[9px] rounded px-1 py-0.5 bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">Shop</span>
                      ) : r.shopify_share_pct >= 20 ? (
                        <ShoppingBag className="inline ml-1 h-3 w-3 text-violet-500" />
                      ) : null}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums ${r.channel === "shopify_only" ? "text-muted-foreground/30" : ""}`}>
                      {r.channel === "shopify_only" ? "—" : fmt(r.fba_on_hand)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.awd_on_hand > 0 ? fmt(r.awd_on_hand) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.tpl_available > 0 ? fmt(r.tpl_available) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(r.inbound)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.total_u_7.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.total_u_30.toFixed(1)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        r.planning_u_30 > r.total_u_30 * 1.1
                          ? "text-amber-700 dark:text-amber-400 font-medium"
                          : ""
                      }`}
                      title={
                        r.holiday_surge_mult > 1.05
                          ? `Holiday plan ${r.planning_u_30.toFixed(1)}/d (${r.holiday_surge_mult.toFixed(2)}× surge)`
                          : "Same as V30 (no holiday surge)"
                      }
                    >
                      {r.planning_u_30.toFixed(1)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${
                        r.holiday_surge_mult >= 2
                          ? "text-amber-700 dark:text-amber-400 font-medium"
                          : r.holiday_surge_mult > 1.05
                            ? "text-amber-600"
                            : "text-muted-foreground"
                      }`}
                    >
                      {r.holiday_surge_mult >= 1.05
                        ? `${r.holiday_surge_mult.toFixed(2)}×`
                        : "—"}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums font-medium ${
                        r.dos < 30
                          ? "text-red-500"
                          : r.dos < 60
                            ? "text-amber-500"
                            : ""
                      }`}
                      title={r.channel === "shopify_only" ? "Warehouse days of cover" : "FBA days of cover"}
                    >
                      {r.dos > 999 ? "999+" : fmt(r.dos)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.pipeline_dos > 999
                        ? "999+"
                        : fmt(r.pipeline_dos)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(r.amz_rec_qty)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums font-medium ${
                        r.our_reorder_qty > 0 ? "text-amber-600" : ""
                      }`}
                    >
                      {fmt(r.our_reorder_qty)}
                    </TableCell>
                    <TableCell className="text-right text-xs"
                      title={r.channel === "shopify_only" ? "Warehouse reaches 0" : "FBA reaches 0"}>
                      {r.stockout_date?.slice(5) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground"
                      title="All owned network stock reaches 0">
                      {r.network_oos_date?.slice(5) ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${FLAG_COLORS[r.flag] ?? ""}`}
                      >
                        {r.flag}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail drawer */}
      {selected && (
        <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
          <SheetContent side="right" className="w-80 sm:w-96 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{selected.sku}</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4">
              {selected.product_name && (
                <p className="text-sm text-muted-foreground" title={`Amazon listing: ${rawTitle(selected.product_name)}`}>
                  {displayTitle(selected.product_name)}
                </p>
              )}
              {selected.asin && (
                <p className="text-xs text-muted-foreground">
                  ASIN: {selected.asin}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    FBA On-hand
                  </p>
                  <p className="text-lg font-semibold">
                    {fmt(selected.fba_on_hand)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {fmt(selected.fulfillable)} avail · {fmt(selected.reserved)} rsv
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    AWD
                  </p>
                  <p className="text-lg font-semibold">
                    {selected.awd_on_hand > 0 ? fmt(selected.awd_on_hand) : "—"}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    3PL
                  </p>
                  <p className="text-lg font-semibold">
                    {selected.tpl_available > 0 ? fmt(selected.tpl_available) : "—"}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Inbound
                  </p>
                  <p className="text-lg font-semibold">
                    {fmt(selected.inbound)}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase text-muted-foreground">
                  Velocity (units/day)
                </h4>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <span />
                  <span className="text-center text-muted-foreground">7d</span>
                  <span className="text-center text-muted-foreground">30d</span>

                  <span className="flex items-center gap-1">
                    <Package className="h-3 w-3 text-amber-500" /> Amazon
                  </span>
                  <span className="text-center tabular-nums">
                    {selected.amazon_u_7.toFixed(1)}
                  </span>
                  <span className="text-center tabular-nums">
                    {selected.amazon_u_30.toFixed(1)}
                  </span>

                  <span className="flex items-center gap-1">
                    <ShoppingBag className="h-3 w-3 text-violet-500" /> Shopify
                  </span>
                  <span className="text-center tabular-nums">
                    {selected.shopify_u_7.toFixed(1)}
                  </span>
                  <span className="text-center tabular-nums">
                    {selected.shopify_u_30.toFixed(1)}
                  </span>

                  <span className="font-medium">Total</span>
                  <span className="text-center tabular-nums font-medium">
                    {selected.total_u_7.toFixed(1)}
                  </span>
                  <span className="text-center tabular-nums font-medium">
                    {selected.total_u_30.toFixed(1)}
                  </span>
                </div>
                {selected.shopify_share_pct >= 20 && (
                  <p className="text-[10px] text-violet-600 dark:text-violet-400">
                    Shopify is {selected.shopify_share_pct}% of 30d demand
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    {selected.channel === "shopify_only" ? "Warehouse DOS" : "FBA DOS (no receipts)"}
                  </p>
                  <p
                    className={`text-lg font-semibold ${
                      selected.dos < 60 ? "text-amber-500" : ""
                    }`}
                  >
                    {selected.dos > 999 ? "999+" : selected.dos}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    {selected.channel === "shopify_only" ? "Total stock" : "+Pipeline (inb+AWD)"}
                  </p>
                  <p className="text-lg font-semibold text-muted-foreground">
                    {selected.channel === "shopify_only"
                      ? fmt(selected.tpl_available)
                      : selected.pipeline_dos > 999
                        ? "999+"
                        : selected.pipeline_dos}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Our Reorder
                  </p>
                  <p className="text-lg font-semibold text-amber-600">
                    {fmt(selected.our_reorder_qty)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Amazon Rec
                  </p>
                  <p className="text-lg font-semibold">
                    {fmt(selected.amz_rec_qty)}
                  </p>
                </div>
              </div>

              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  V30: {selected.total_u_30.toFixed(1)} u/day
                  {selected.planning_u_30 > selected.total_u_30 * 1.05 && (
                    <> · Holiday plan: {selected.planning_u_30.toFixed(1)} u/day</>
                  )}
                  {selected.holiday_surge_mult >= 1.05 && (
                    <> · 2025 surge {selected.holiday_surge_mult.toFixed(2)}×</>
                  )}
                </p>
                {selected.stockout_date && (
                  <p>
                    {selected.channel === "shopify_only" ? "Warehouse" : "FBA"} stockout: {selected.stockout_date}
                  </p>
                )}
                {selected.network_oos_date && selected.network_oos_date !== selected.stockout_date && (
                  <p>
                    Network OOS (all stock): {selected.network_oos_date}
                  </p>
                )}
                {selected.amz_rec_ship && (
                  <p>Amazon ship by: {selected.amz_rec_ship}</p>
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Settings drawer */}
      {showSettings && localSettings && (
        <Sheet
          open={showSettings}
          onOpenChange={(v) => !v && setShowSettings(false)}
        >
          <SheetContent side="right" className="w-80 sm:w-96">
            <SheetHeader>
              <SheetTitle>Inventory Settings</SheetTitle>
            </SheetHeader>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Target Cover (days)
                </label>
                <input
                  type="number"
                  value={localSettings.target_cover_days}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      target_cover_days: Number(e.target.value),
                    })
                  }
                  className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Lead Time (days)
                </label>
                <input
                  type="number"
                  value={localSettings.lead_time_days}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      lead_time_days: Number(e.target.value),
                    })
                  }
                  className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={localSettings.holiday_mode}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      holiday_mode: e.target.checked,
                    })
                  }
                />
                Holiday Mode (target 90d cover)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={localSettings.include_inbound}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      include_inbound: e.target.checked,
                    })
                  }
                />
                Include inbound in on-hand
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={localSettings.include_3pl ?? true}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      include_3pl: e.target.checked,
                    })
                  }
                />
                Include 3PL (Ship Sidekick) in on-hand
              </label>
              <Button onClick={saveSettings} disabled={saving} className="w-full">
                {saving ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Footer */}
      <p className="text-xs text-muted-foreground">
        Projections use Amazon + Shopify unit demand for matched SKUs. Amazon
        forecasts in Seller Central may differ. Planning aid — not financial
        advice.
      </p>
    </div>
  );
}
