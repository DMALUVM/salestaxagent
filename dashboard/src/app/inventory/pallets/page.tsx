"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInventory } from "@/lib/hooks";
import type {
  InventoryLeadtimeSummary,
  InventorySettings,
  InventorySkuSignals,
  InventorySnapshot,
  SkuVelocity,
} from "@/lib/types";
import {
  amazonInventoryReorder,
  DEFAULT_INVENTORY_SETTINGS,
} from "@/lib/inventory-reorder";
import {
  allocateMonthlyUnits,
  AMAZON_IN_BY,
  daysOfSupply,
  forecastByHolidayMonth,
  HOLIDAY_DEMAND_MONTHS,
  holidayMonthPlan,
  inventoryFlag,
  monthPalletFillPct,
  monthShortfall,
  packPallets,
  PALLET_MAX_UNITS,
  planningDaily,
  RATE_DIVERGENCE_WARN_PCT,
  shipByForAmazonDeadline,
  skuPackPriority,
} from "@/lib/pallet-plan";
import { coverTargetDays } from "@/lib/inventory-reorder";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import { Shield, Package, AlertTriangle, Download, FileText, Lock, Unlock, Copy, Check } from "lucide-react";
import Link from "next/link";

const SKUS = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"];
const SKU_LABELS: Record<string, string> = {
  DDPE0001Shop: "Unscented 3pk",
  DDPE0002Shop: "Peppermint 3pk",
  DDPE0003Shop: "Sweet Orange 3pk",
  DDPE0004Shop: "Assorted 3pk",
};
const SKU_SHORT: Record<string, string> = {
  DDPE0001Shop: "Unscented",
  DDPE0002Shop: "Peppermint",
  DDPE0003Shop: "Orange",
  DDPE0004Shop: "Assorted",
};
const PALLET_MAX = PALLET_MAX_UNITS;
const TARGET = AMAZON_IN_BY;
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtWeek(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-");
  return `${MONTH_NAMES[parseInt(mo)]} ${y}`;
}

function daysInMonth(m: string) {
  const [y, mo] = m.split("-");
  return new Date(parseInt(y), parseInt(mo), 0).getDate();
}

function getMonthList(start: Date, n: number): string[] {
  const months: string[] = [];
  let y = start.getFullYear(), m = start.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
}

interface SkuPlan {
  sku: string; label: string;
  novDemand: number; decDemand: number; janDemand: number;
  novDecDemand: number; plannedDemand: number;
  fba: number; inbound: number; awd: number; tpl: number; supply: number; gap: number;
}
interface CoverWeek {
  week: string; fba: number; demand: number; receipt: number;
  dailyRate: number; coverDays: number | null; flagged: boolean;
}
interface SkuProjection {
  sku: string; label: string; fbaStart: number;
  weeks: CoverWeek[]; flaggedCount: number;
}
interface PackedPallet { num: number; mix: Record<string, number>; units: number }
interface MfgMonthEntry {
  month: string; label: string; status: "FIRM" | "INDICATIVE";
  pallets: number; units: number; mix: Record<string, number>; shipBy: string;
  overdue?: boolean;
  packed: PackedPallet[];
  fillPct: number;
  arriveBy?: string;
}
interface MfgScenario { entries: MfgMonthEntry[]; totalUnits: number; totalPallets: number; }
interface MfgSkuSummary {
  sku: string; label: string; holidayDemand: number;
  novDemand: number; decDemand: number; janDemand: number;
  holidayForecast: number;
  fba: number; inbound: number; awd: number; tpl: number;
  transfer: number; manufacture: number;
  holidayManufacture: number; inventoryReorder: number;
  v30: number; planningDaily: number; invV30: number | null;
  rateDivergencePct: number | null; dos: number; pipelineDos: number;
  flag: "CRITICAL" | "OK";
  targetDays: number; leadDays: number; onHand: number;
}
interface MfgTransfer { sku: string; source: string; units: number; timing: string; }

function getMonday(d: Date): Date {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
}
function toIso(d: Date): string { return d.toISOString().slice(0, 10); }

function buildMfgBrief(skuSummary: MfgSkuSummary[]): string {
  const L: string[] = [];
  L.push("Tallowbourn holiday sell-through (in Amazon by " + TARGET + ")");
  L.push("Nov/Dec/Jan are the months we are covering — not the ship months.");
  L.push("Those units produce now and ship on September / October pallets.");
  L.push("");
  L.push(
    "SKU".padEnd(14) +
    "Nov".padStart(8) +
    "Dec".padStart(8) +
    "Jan".padStart(8) +
    "Planned".padStart(9) +
    "Mfg".padStart(9),
  );
  for (const s of skuSummary) {
    L.push(
      (SKU_SHORT[s.sku] ?? s.sku).padEnd(14) +
      fmt(s.novDemand).padStart(8) +
      fmt(s.decDemand).padStart(8) +
      fmt(s.janDemand).padStart(8) +
      fmt(s.holidayDemand).padStart(9) +
      fmt(s.manufacture).padStart(9),
    );
  }
  const tot = (pick: (s: MfgSkuSummary) => number) => skuSummary.reduce((a, s) => a + pick(s), 0);
  L.push(
    "TOTAL".padEnd(14) +
    fmt(tot((s) => s.novDemand)).padStart(8) +
    fmt(tot((s) => s.decDemand)).padStart(8) +
    fmt(tot((s) => s.janDemand)).padStart(8) +
    fmt(tot((s) => s.holidayDemand)).padStart(9) +
    fmt(tot((s) => s.manufacture)).padStart(9),
  );
  L.push("");
  L.push("August pallet = inventory reorder only (keep Amazon from stocking out now).");
  L.push("Planned = max(forecast Nov+Dec+Jan, planning velocity × 92).");
  return L.join("\n") + "\n";
}

// ── Downloads ──
function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function buildMfgCsv(
  primary: MfgScenario, sensitivity: MfgScenario,
  skuSummary: MfgSkuSummary[], skuSummarySens: MfgSkuSummary[],
  transfers: MfgTransfer[],
): string {
  const L: string[] = [];
  L.push("Section,SKU,SKU_Label,Nov_Demand,Dec_Demand,Jan_Demand,Holiday_Forecast,Holiday_Demand,FBA,Inbound,AWD,TPL,Transfer,Inventory_Reorder,Holiday_Manufacture,Manufacture,V30,Target_Days,Lead_Days,Scenario");
  for (const [sc, rows] of [["correction_factor", skuSummary], ["actual_2025", skuSummarySens]] as const) {
    for (const s of rows) L.push(`SKU_Summary,${s.sku},${s.label},${s.novDemand},${s.decDemand},${s.janDemand},${s.holidayForecast},${s.holidayDemand},${s.fba},${s.inbound},${s.awd},${s.tpl},${s.transfer},${s.inventoryReorder},${s.holidayManufacture},${s.manufacture},${s.v30},${s.targetDays},${s.leadDays},${sc}`);
  }
  L.push(""); L.push("Section,Month,Month_Label,Status,SKU,SKU_Label,Units,Pallets,Ship_By,Scenario");
  for (const [sc, label] of [[primary, "correction_factor"], [sensitivity, "actual_2025"]] as const) {
    for (const e of sc.entries) {
      if (!Object.keys(e.mix).length) L.push(`Monthly,${e.month},${e.label},${e.status},,,0,0,${e.shipBy},${label}`);
      for (const [sku, qty] of Object.entries(e.mix)) L.push(`Monthly,${e.month},${e.label},${e.status},${sku},${SKU_LABELS[sku]??sku},${qty},${e.pallets},${e.shipBy},${label}`);
    }
  }
  L.push(""); L.push("Section,SKU,SKU_Label,Source,Units,Timing");
  for (const t of transfers) L.push(`Transfer,${t.sku},${SKU_LABELS[t.sku]??t.sku},${t.source},${t.units},${t.timing}`);
  return L.join("\n") + "\n";
}

function buildMfgSheet(
  primary: MfgScenario, sensitivity: MfgScenario,
  skuSummary: MfgSkuSummary[], skuSummarySens: MfgSkuSummary[],
  transfers: MfgTransfer[], generated: string,
): string {
  const L: string[] = [];
  L.push("=================================================================");
  L.push("TALLOWBOURN"); L.push("MANUFACTURER PLANNING SHEET");
  L.push("Lip Balm 3pk · Holiday Production Schedule");
  L.push(`Generated: ${generated}`);
  L.push("=================================================================");
  L.push(""); L.push("SKU REFERENCE:");
  for (const [sku, label] of Object.entries(SKU_LABELS)) L.push(`  ${sku}  =  ${label}`);
  L.push("");   L.push(`Demand period: Nov + Dec + Jan (sell-through — alert the manufacturer)`);
  L.push(`Pallet capacity: ${fmt(PALLET_MAX)} cartons each; multiple pallets/month OK`);
  L.push(`Current month = inventory reorder. Sep/Oct pallets cover Nov/Dec/Jan so Amazon is stocked by ${TARGET}.`);
  L.push(`All units in Amazon FBA by: ${TARGET}`);
  L.push(`3PL policy: transfer only (does NOT reduce manufacture)`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("HOLIDAY SELL-THROUGH (correction_factor) — tell the manufacturer"); L.push("-----------------------------------------------------------------");
  L.push(`  ${"SKU".padEnd(14)} ${"Nov".padStart(7)} ${"Dec".padStart(7)} ${"Jan".padStart(7)} ${"Planned".padStart(8)} ${"Reorder".padStart(8)} ${"Mfg".padStart(8)}`);
  for (const s of skuSummary) {
    L.push(`  ${(SKU_SHORT[s.sku]??s.sku).padEnd(14)} ${fmt(s.novDemand).padStart(7)} ${fmt(s.decDemand).padStart(7)} ${fmt(s.janDemand).padStart(7)} ${fmt(s.holidayDemand).padStart(8)} ${fmt(s.inventoryReorder).padStart(8)} ${fmt(s.manufacture).padStart(8)}`);
  }
  const tot = (pick: (s: MfgSkuSummary) => number) => skuSummary.reduce((a, s) => a + pick(s), 0);
  L.push(`  ${"TOTAL".padEnd(14)} ${fmt(tot((s) => s.novDemand)).padStart(7)} ${fmt(tot((s) => s.decDemand)).padStart(7)} ${fmt(tot((s) => s.janDemand)).padStart(7)} ${fmt(tot((s) => s.holidayDemand)).padStart(8)} ${fmt(tot((s) => s.inventoryReorder)).padStart(8)} ${fmt(tot((s) => s.manufacture)).padStart(8)}`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("PRODUCTION SCHEDULE — month 1 = inventory reorder + leftover"); L.push("-----------------------------------------------------------------");
  for (const e of primary.entries) {
    L.push(""); L.push(`  ${e.label}  —  ${e.status}`);
    if (e.units === 0) { L.push("    No production needed."); continue; }
    L.push(`    Pallets: ${e.pallets}  (${fmt(e.units)} units)`);
    for (const sku of SKUS) { const q = e.mix[sku]; if (q && q > 0) L.push(`      ${SKU_LABELS[sku]}: ${fmt(q)}`); }
    L.push(`    Ship by: ${e.shipBy}`);
  }
  L.push(""); L.push(`  TOTAL: ${fmt(primary.totalUnits)} units across ${primary.totalPallets} pallet(s)`);
  if (transfers.length) {
    L.push(""); L.push("-----------------------------------------------------------------");
    L.push("TRANSFERS TO FBA"); L.push("-----------------------------------------------------------------");
    for (const t of transfers) { L.push(`  ${t.source.padEnd(5)} ${(SKU_SHORT[t.sku]??t.sku).padEnd(14)} ${fmt(t.units).padStart(7)} units`); L.push(`        ${t.timing}`); }
  }
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("SENSITIVITY: actual_2025"); L.push("-----------------------------------------------------------------");
  for (const s of skuSummarySens) L.push(`  ${(SKU_SHORT[s.sku]??s.sku).padEnd(14)} Demand ${fmt(s.holidayDemand).padStart(7)}  Mfg ${fmt(s.manufacture).padStart(7)}`);
  const sensMfg = skuSummarySens.reduce((a, s) => a + s.manufacture, 0);
  L.push(`  TOTAL: ${fmt(sensMfg)} manufacture`);
  for (const e of sensitivity.entries) {
    if (e.units > 0) { const mix = Object.entries(e.mix).filter(([,q])=>q>0).map(([s,q])=>`${SKU_SHORT[s]??s} ${fmt(q)}`).join(", "); L.push(`  ${e.label}: ${fmt(e.units)} units (${e.pallets}p) — ${mix}`); }
    else L.push(`  ${e.label}: no production needed`);
  }
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("NOTES:"); L.push("  - Nov/Dec/Jan are sell-through months, not production months.");
  L.push("  - Alert the manufacturer with those totals; they ship on Sep/Oct pallets.");
  L.push("  - Current month = inventory reorder so Amazon does not stock out now.");
  L.push("  - FIRM = committed. INDICATIVE = forecast-driven, may change.");
  L.push("  - Manufacture assumes 3PL transferred separately."); L.push("  - This is a planning aid, not a purchase order.");
  L.push("-----------------------------------------------------------------");
  return L.join("\n") + "\n";
}

export default function PalletPlanPage() {
  const configured = isConfigured();
  const { data: raw, loading } = useInventory();
  const [include3pl, setInclude3pl] = useState(true);
  const [includeAwd, setIncludeAwd] = useState(true);
  const [coverSku, setCoverSku] = useState(SKUS[0]);
  const [briefCopied, setBriefCopied] = useState(false);

  // Committed months (persisted in localStorage)
  const [committed, setCommitted] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pallet_committed_months");
      if (saved) setCommitted(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
  }, []);
  const toggleCommit = useCallback((month: string) => {
    setCommitted((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month); else next.add(month);
      localStorage.setItem("pallet_committed_months", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const snapshots = (raw?.snapshots ?? []) as InventorySnapshot[];
  const forecasts = (raw?.forecast ?? []) as { sku: string; week_start: string; scenario: string; units: number }[];
  const awdList = (raw?.awd ?? []) as { sku: string; awd_on_hand: number }[];
  const tplList = (raw?.tpl ?? []) as { sku: string; available: number }[];
  const velocityList = (raw?.velocity ?? []) as SkuVelocity[];
  const settings = (raw?.settings ?? DEFAULT_INVENTORY_SETTINGS) as InventorySettings;
  const signalRows = (raw?.signals ?? []) as InventorySkuSignals[];
  const leadtime = (raw?.leadtime ?? null) as InventoryLeadtimeSummary | null;
  const coverTarget = coverTargetDays(settings);

  // ── Pallet plan ──
  const { skuPlans, totalGap, totalDemand, totalSupply } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));
    const plans: SkuPlan[] = [];
    let tGap = 0, tDemand = 0, tSupply = 0;
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      const fba = Number(snap?.fulfillable ?? 0) + Number(snap?.reserved ?? 0) +
        Number(snap?.researching ?? 0) + Number(snap?.unfulfillable ?? 0);
      const inbound = Number(snap?.inbound_working ?? 0) + Number(snap?.inbound_shipped ?? 0) +
        Number(snap?.inbound_receiving ?? 0);
      const awd = includeAwd ? Number(awdMap.get(sku)?.awd_on_hand ?? 0) : 0;
      const tpl = include3pl ? Number(tplMap.get(sku)?.available ?? 0) : 0;
      const supply = fba + inbound + awd + tpl;
      const monthFc = forecastByHolidayMonth(forecasts, sku, "correction_factor");
      const novDemand = monthFc["2026-11"] ?? 0;
      const decDemand = monthFc["2026-12"] ?? 0;
      const janDemand = monthFc["2027-01"] ?? 0;
      const novDecDemand = novDemand + decDemand;
      const plannedDemand = novDecDemand + janDemand;
      const gap = Math.max(plannedDemand - supply, 0);
      tGap += gap; tDemand += plannedDemand; tSupply += supply;
      plans.push({
        sku, label: SKU_LABELS[sku] ?? sku,
        novDemand, decDemand, janDemand, novDecDemand, plannedDemand,
        fba, inbound, awd, tpl, supply, gap,
      });
    }
    return { skuPlans: plans, totalGap: tGap, totalDemand: tDemand, totalSupply: tSupply };
  }, [snapshots, forecasts, awdList, tplList, include3pl, includeAwd]);

  // ── FBA Cover Projection ──
  const { coverProjections, coverAlerts } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));
    const velMap = new Map(velocityList.map((v) => [v.sku, v]));
    const fcMap = new Map<string, Map<string, number>>();
    for (const f of forecasts) {
      if (f.scenario !== "correction_factor") continue;
      if (!fcMap.has(f.sku)) fcMap.set(f.sku, new Map());
      fcMap.get(f.sku)!.set(f.week_start?.slice(0, 10), Number(f.units));
    }
    const now = new Date();
    const monday = getMonday(now);
    const endDate = new Date(2026, 11, 28);
    const weeks: Date[] = [];
    const cur = new Date(monday);
    while (cur <= endDate) { weeks.push(new Date(cur)); cur.setDate(cur.getDate() + 7); }

    // Blended daily velocity: 50% V7 + 30% V30 + 20% V90 (renormalized)
    // NOTE: total_u_* are already units/day (computed by _units_per_day = total/window)
    function blendedDailyVelocity(vel: SkuVelocity): number {
      const windows: [number, number][] = [
        [vel.total_u_7, 0.50],
        [vel.total_u_30, 0.30],
        [vel.total_u_90, 0.20],
      ];
      const valid = windows.filter(([rate]) => rate > 0);
      if (!valid.length) return 0;
      const wSum = valid.reduce((a, [, w]) => a + w, 0);
      return valid.reduce((a, [rate, w]) => a + rate * w / wSum, 0);
    }

    function getWeekDemand(sku: string, weekDate: Date): number {
      const fc = fcMap.get(sku);
      if (fc) {
        for (let off = 0; off <= 3; off++) {
          const d1 = new Date(weekDate); d1.setDate(d1.getDate() + off);
          const v = fc.get(toIso(d1)); if (v !== undefined) return v;
          if (off > 0) { const d2 = new Date(weekDate); d2.setDate(d2.getDate() - off); const v2 = fc.get(toIso(d2)); if (v2 !== undefined) return v2; }
        }
      }
      const vel = velMap.get(sku);
      if (vel) return blendedDailyVelocity(vel) * 7;
      return 0;
    }

    const projections: SkuProjection[] = [];
    const alerts: { sku: string; week: string; coverDays: number; fba: number }[] = [];
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      const fbaStart = Number(snap?.fulfillable ?? 0) + Number(snap?.reserved ?? 0) + Number(snap?.researching ?? 0) + Number(snap?.unfulfillable ?? 0);
      const inboundNow = Number(snap?.inbound_working ?? 0) + Number(snap?.inbound_shipped ?? 0) + Number(snap?.inbound_receiving ?? 0);
      const awdNow = includeAwd ? Number(awdMap.get(sku)?.awd_on_hand ?? 0) : 0;
      const tplNow = include3pl ? Number(tplMap.get(sku)?.available ?? 0) : 0;
      const receipts: Record<number, number> = {};
      if (inboundNow > 0) receipts[Math.min(1, weeks.length - 1)] = (receipts[Math.min(1, weeks.length - 1)] ?? 0) + inboundNow;
      if (awdNow > 0) receipts[Math.min(2, weeks.length - 1)] = (receipts[Math.min(2, weeks.length - 1)] ?? 0) + awdNow;
      if (tplNow > 0) receipts[Math.min(3, weeks.length - 1)] = (receipts[Math.min(3, weeks.length - 1)] ?? 0) + tplNow;
      let fba = fbaStart;
      const weekData: CoverWeek[] = [];
      let flaggedCount = 0;
      for (let wi = 0; wi < weeks.length; wi++) {
        const wDate = weeks[wi]; const wIso = toIso(wDate);
        const receipt = receipts[wi] ?? 0; fba += receipt;
        const demand = getWeekDemand(sku, wDate); fba = Math.max(fba - demand, 0);
        let forwardUnits = 0, forwardWeeks = 0;
        for (let fi = wi; fi < Math.min(wi + 9, weeks.length); fi++) { forwardUnits += getWeekDemand(sku, weeks[fi]); forwardWeeks++; }
        let dailyRate = 0, coverDays: number | null = null, flagged = false;
        if (forwardUnits > 0 && forwardWeeks > 0) {
          dailyRate = forwardUnits / (forwardWeeks * 7);
          coverDays = dailyRate > 0 ? Math.round(fba / dailyRate) : null;
          flagged = coverDays !== null && coverDays < coverTarget;
        }
        if (flagged) { flaggedCount++; alerts.push({ sku, week: wIso, coverDays: coverDays!, fba: Math.round(fba) }); }
        weekData.push({ week: wIso, fba: Math.round(fba), demand: Math.round(demand), receipt, dailyRate: Math.round(dailyRate * 10) / 10, coverDays, flagged });
      }
      projections.push({ sku, label: SKU_LABELS[sku] ?? sku, fbaStart, weeks: weekData, flaggedCount });
    }
    return { coverProjections: projections, coverAlerts: alerts };
  }, [snapshots, forecasts, awdList, tplList, velocityList, include3pl, includeAwd, coverTarget]);

  // ── Manufacturer Heads-Up (demand - FBA - inbound - AWD; 3PL = transfer only) ──
  const [tplOffsetsProduction, setTplOffsetsProduction] = useState(false);

  const { mfgPrimary, mfgSensitivity, mfgSkuSummary, mfgSkuSummarySens, mfgTransfers, month1Shortfall } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));
    const velMap = new Map(velocityList.map((v) => [v.sku, v]));
    const sigMap = new Map(signalRows.map((r) => [r.sku, r]));
    const today = new Date();
    const productionMonths = getMonthList(today, 3);
    const todayIso = today.toISOString().slice(0, 10);

    const inv: Record<string, {
      fba: number; inbound: number; awd: number; tpl: number;
      inventoryReorder: number; v30: number; planningDaily: number;
      invV30: number | null; rateDivergencePct: number | null;
      dos: number; pipelineDos: number; flag: "CRITICAL" | "OK";
      targetDays: number; leadDays: number; onHand: number;
    }> = {};
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      const vel = velMap.get(sku);
      const sig = sigMap.get(sku);
      const fba = Number(snap?.fulfillable ?? 0) + Number(snap?.reserved ?? 0) +
        Number(snap?.researching ?? 0) + Number(snap?.unfulfillable ?? 0);
      const inbound = Number(snap?.inbound_working ?? 0) + Number(snap?.inbound_shipped ?? 0) +
        Number(snap?.inbound_receiving ?? 0);
      const awd = Number(awdMap.get(sku)?.awd_on_hand ?? 0);
      const tpl = Number(tplMap.get(sku)?.available ?? 0);
      const v30 = Number(vel?.total_u_30 ?? 0);
      const rec = amazonInventoryReorder({
        settings,
        sig,
        leadtime,
        fba, inbound, awd, tpl,
        dailyVelocity: v30,
      });
      const dos = daysOfSupply(fba, v30);
      inv[sku] = {
        fba, inbound, awd, tpl,
        inventoryReorder: rec.reorderQty,
        v30,
        planningDaily: planningDaily(vel ?? {}),
        invV30: sig?.inventory_u_30 != null ? Number(sig.inventory_u_30) : null,
        rateDivergencePct: sig?.rate_divergence_pct != null ? Number(sig.rate_divergence_pct) : null,
        dos,
        pipelineDos: daysOfSupply(fba + inbound + awd, v30),
        flag: inventoryFlag(dos, v30),
        targetDays: rec.targetDays,
        leadDays: rec.leadDays,
        onHand: rec.onHand,
      };
    }

    function buildScenario(scenario: string): { sc: MfgScenario; summaries: MfgSkuSummary[] } {
      const summaries: MfgSkuSummary[] = [];
      const holidayMfg: Record<string, number> = {};
      const reorderBySku: Record<string, number> = {};
      for (const sku of SKUS) {
        const i = inv[sku];
        const monthPlan = holidayMonthPlan(
          forecastByHolidayMonth(forecasts, sku, scenario),
          i.planningDaily,
          true,
        );
        const d = monthPlan.plannedTotal;
        const nov = monthPlan.months.find((m) => m.month === "2026-11")?.forecast ?? 0;
        const dec = monthPlan.months.find((m) => m.month === "2026-12")?.forecast ?? 0;
        const jan = monthPlan.months.find((m) => m.month === "2027-01")?.forecast ?? 0;
        let deductions = i.fba + i.inbound + i.awd;
        if (tplOffsetsProduction) deductions += i.tpl;
        const holidayManufacture = Math.max(0, d - deductions);
        const manufacture = Math.max(i.inventoryReorder, holidayManufacture);
        holidayMfg[sku] = holidayManufacture;
        reorderBySku[sku] = i.inventoryReorder;
        summaries.push({
          sku, label: SKU_LABELS[sku] ?? sku, holidayDemand: d,
          novDemand: nov, decDemand: dec, janDemand: jan,
          holidayForecast: monthPlan.forecastTotal,
          fba: i.fba, inbound: i.inbound, awd: i.awd, tpl: i.tpl,
          transfer: i.tpl + i.awd, manufacture,
          holidayManufacture, inventoryReorder: i.inventoryReorder,
          v30: i.v30, planningDaily: i.planningDaily, invV30: i.invV30,
          rateDivergencePct: i.rateDivergencePct, dos: i.dos, pipelineDos: i.pipelineDos,
          flag: i.flag, targetDays: i.targetDays, leadDays: i.leadDays, onHand: i.onHand,
        });
      }

      const leadDays = Math.max(...SKUS.map((sku) => inv[sku].leadDays), 19);
      const mixes = allocateMonthlyUnits(
        SKUS, reorderBySku, holidayMfg, productionMonths,
        { amazonInBy: TARGET, leadDays },
      );
      const flags = Object.fromEntries(SKUS.map((sku) => [sku, inv[sku].flag]));
      const priority = skuPackPriority(SKUS, flags, reorderBySku);
      const entries: MfgMonthEntry[] = productionMonths.map((m) => {
        const mix = mixes[productionMonths.indexOf(m)] ?? {};
        const packed = packPallets(mix, priority, PALLET_MAX);
        const total = Object.values(mix).reduce((a, b) => a + b, 0);
        const shipBy = shipByForAmazonDeadline(m, TARGET, leadDays);
        const arrive = new Date(`${shipBy}T00:00:00`);
        arrive.setDate(arrive.getDate() + leadDays);
        const arriveBy = arrive.toISOString().slice(0, 10);
        return {
          month: m, label: monthLabel(m),
          status: committed.has(m) ? "FIRM" : "INDICATIVE",
          pallets: packed.length,
          units: total, mix, packed,
          fillPct: monthPalletFillPct(total, packed.length, PALLET_MAX),
          shipBy,
          arriveBy,
          overdue: todayIso > shipBy && total > 0,
        };
      });
      return {
        sc: { entries, totalUnits: entries.reduce((a, e) => a + e.units, 0), totalPallets: entries.reduce((a, e) => a + e.pallets, 0) },
        summaries,
      };
    }

    const prim = buildScenario("correction_factor");
    const sens = buildScenario("actual_2025");

    // Transfers (scenario-independent)
    const transfers: MfgTransfer[] = [];
    for (const sku of SKUS) {
      const i = inv[sku];
      if (i.awd > 0) transfers.push({ sku, source: "AWD", units: i.awd, timing: "Transfer to FBA immediately (~2 weeks)" });
      if (i.tpl > 0) transfers.push({ sku, source: "3PL", units: i.tpl, timing: "Ship to FBA by Sep 30 for pre-holiday receiving" });
    }

    const reorderBySku = Object.fromEntries(
      SKUS.map((sku) => [sku, inv[sku].inventoryReorder]),
    );
    return {
      mfgPrimary: prim.sc, mfgSensitivity: sens.sc,
      mfgSkuSummary: prim.summaries, mfgSkuSummarySens: sens.summaries,
      mfgTransfers: transfers,
      month1Shortfall: monthShortfall(prim.sc.entries[0]?.mix ?? {}, reorderBySku, SKUS),
    };
  }, [snapshots, forecasts, awdList, tplList, velocityList, signalRows, leadtime, settings, committed, tplOffsetsProduction]);

  if (!configured) return <SetupPrompt />;
  if (loading) return <LoadingState />;

  const selectedProj = coverProjections.find((p) => p.sku === coverSku);
  const generated = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pallet Planner</h1>
          <p className="text-sm text-muted-foreground">
            August = inventory reorder · Sep/Oct ship the Nov–Jan sell-through so it is in Amazon by {TARGET} · {fmt(PALLET_MAX)} cartons/pallet
          </p>
        </div>
        <Link href="/inventory"><Button variant="outline" size="sm">← Inventory</Button></Link>
      </div>

      {/* Toggles */}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={include3pl} onChange={(e) => setInclude3pl(e.target.checked)} />
          Include 3PL transfer to FBA by {TARGET}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeAwd} onChange={(e) => setIncludeAwd(e.target.checked)} />
          Include AWD in supply
        </label>
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Holiday Demand</p>
            <p className="text-2xl font-semibold tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.holidayDemand, 0))}</p>
            <p className="text-xs text-muted-foreground">Nov+Dec+Jan, floored by planning rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Supply Available</p>
            <p className="text-2xl font-semibold tabular-nums">{fmt(totalSupply)}</p>
          </CardContent>
        </Card>
        <Card className={totalGap > 0 ? "border-red-500/40" : "border-emerald-500/40"}>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Manufacture</p>
            <p className={`text-2xl font-semibold tabular-nums ${mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0) > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0) > 0
                ? fmt(mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0))
                : "Covered"}
            </p>
            <p className="text-xs text-muted-foreground">max(inventory reorder, holiday gap)</p>
          </CardContent>
        </Card>
        <Card className={coverAlerts.length > 0 ? "border-red-500/40" : "border-emerald-500/40"}>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">FBA Cover Alerts</p>
            <p className={`text-2xl font-semibold tabular-nums ${coverAlerts.length > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {coverAlerts.length > 0 ? coverAlerts.length : "OK"}
            </p>
            <p className="text-xs text-muted-foreground">weeks &lt; {coverTarget}d</p>
          </CardContent>
        </Card>
      </div>

      {/* ══════ SHARE WITH MANUFACTURER ══════ */}
      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Share with Manufacturer</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={async () => {
                const text = buildMfgBrief(mfgSkuSummary);
                try {
                  await navigator.clipboard.writeText(text);
                  setBriefCopied(true);
                  window.setTimeout(() => setBriefCopied(false), 2000);
                } catch {
                  downloadBlob(text, `mfg_brief_${generated}.txt`, "text/plain");
                }
              }}>
                {briefCopied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                {briefCopied ? "Copied" : "Copy Nov–Jan brief"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => {
                downloadBlob(buildMfgCsv(mfgPrimary, mfgSensitivity, mfgSkuSummary, mfgSkuSummarySens, mfgTransfers),
                  `mfg_headsup_${generated}.csv`, "text/csv");
              }}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => {
                downloadBlob(buildMfgSheet(mfgPrimary, mfgSensitivity, mfgSkuSummary, mfgSkuSummarySens, mfgTransfers, generated),
                  `mfg_planning_sheet_${generated}.txt`, "text/plain");
              }}>
                <FileText className="mr-1.5 h-3.5 w-3.5" /> Planning Sheet
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-1">
            <p className="text-xs text-muted-foreground">
              Nov/Dec/Jan are sell-through — copy the brief to alert the manufacturer. Those units ship on Sep/Oct pallets and arrive by {TARGET}.
            </p>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={tplOffsetsProduction}
                onChange={(e) => setTplOffsetsProduction(e.target.checked)} />
              3PL offsets production
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Per-SKU summary table */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">V30</TableHead>
                  <TableHead className="text-right">Inv V30</TableHead>
                  <TableHead className="text-right">Recv</TableHead>
                  <TableHead className="text-right">DOS</TableHead>
                  <TableHead className="text-right">Nov</TableHead>
                  <TableHead className="text-right">Dec</TableHead>
                  <TableHead className="text-right">Jan</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Reorder</TableHead>
                  <TableHead className="text-right">FBA</TableHead>
                  <TableHead className="text-right">Inbnd</TableHead>
                  <TableHead className="text-right">3PL</TableHead>
                  <TableHead className="text-right font-semibold">Manufacture</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mfgSkuSummary.map((s) => (
                  <TableRow key={s.sku}>
                    <TableCell className="font-medium text-xs">{SKU_SHORT[s.sku]}</TableCell>
                    <TableCell>
                      <Badge variant={s.flag === "CRITICAL" ? "destructive" : "secondary"} className="text-[10px]">
                        {s.flag}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.v30.toFixed(1)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${(s.rateDivergencePct ?? 0) > RATE_DIVERGENCE_WARN_PCT ? "text-amber-500" : ""}`}>
                      {s.invV30 != null ? s.invV30.toFixed(1) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.leadDays}d</TableCell>
                    <TableCell className={`text-right tabular-nums ${s.dos < 60 ? "text-amber-500" : ""}`}>{s.dos}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.novDemand)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.decDemand)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.janDemand)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(s.holidayDemand)}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${s.inventoryReorder > 0 ? "text-amber-500" : "text-muted-foreground"}`}>
                      {s.inventoryReorder > 0 ? fmt(s.inventoryReorder) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.fba)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.inbound > 0 ? fmt(s.inbound) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{s.tpl > 0 ? fmt(s.tpl) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-primary">{fmt(s.manufacture)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell>TOTAL</TableCell>
                  <TableCell colSpan={5} />
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.novDemand, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.decDemand, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.janDemand, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.holidayDemand, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums text-amber-500">{fmt(mfgSkuSummary.reduce((a, s) => a + s.inventoryReorder, 0))}</TableCell>
                  <TableCell colSpan={3} />
                  <TableCell className="text-right tabular-nums text-primary">{fmt(mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {HOLIDAY_DEMAND_MONTHS.map((spec) => {
              const key = spec.month === "2026-11" ? "novDemand"
                : spec.month === "2026-12" ? "decDemand"
                  : "janDemand";
              const total = mfgSkuSummary.reduce((a, s) => a + s[key], 0);
              return (
                <div key={spec.month} className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-[10px] uppercase text-muted-foreground">
                    {spec.label} · sell-through
                  </p>
                  <p className="text-xl font-semibold tabular-nums">{fmt(total)}</p>
                  <div className="mt-1 space-y-0.5">
                    {mfgSkuSummary.map((s) => (
                      <div key={s.sku} className="flex justify-between text-[11px]">
                        <span className="text-muted-foreground">{SKU_SHORT[s.sku]}</span>
                        <span className="tabular-nums">{fmt(s[key])}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    Not a production month. Ships on Sep/Oct pallets · in Amazon by {TARGET.slice(5)}
                  </p>
                </div>
              );
            })}
          </div>

          {Object.keys(month1Shortfall).length > 0 && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-500">
              Month 1 is still short of the inventory reorder:{" "}
              {Object.entries(month1Shortfall).map(([sku, qty]) => `${SKU_SHORT[sku]} ${fmt(qty)}`).join(", ")}.
            </div>
          )}

          {/* Month cards */}
          <div className="grid gap-4 sm:grid-cols-3">
            {mfgPrimary.entries.map((entry, idx) => {
              const sensEntry = mfgSensitivity.entries[idx];
              const isFirm = entry.status === "FIRM";
              return (
                <div key={entry.month} className={`rounded-lg border p-4 ${isFirm ? "border-primary/40 bg-primary/5" : ""}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-medium text-sm">{entry.label}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Badge variant={isFirm ? "default" : "secondary"} className="text-[10px]">
                          {entry.status}
                        </Badge>
                        {idx === 0 && <Badge variant="outline" className="text-[10px]">inventory reorder</Badge>}
                        {["2026-09", "2026-10"].includes(entry.month) && (
                          <Badge variant="outline" className="text-[10px]">holiday in by {TARGET.slice(5)}</Badge>
                        )}
                        {entry.overdue && <Badge variant="destructive" className="text-[10px]">overdue</Badge>}
                      </div>
                    </div>
                    <button onClick={() => toggleCommit(entry.month)}
                      className="p-1.5 rounded-md hover:bg-muted transition-colors"
                      title={isFirm ? "Uncommit" : "Mark as committed"}>
                      {isFirm ? <Lock className="h-3.5 w-3.5 text-primary" /> : <Unlock className="h-3.5 w-3.5 text-muted-foreground" />}
                    </button>
                  </div>

                  {entry.units === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No production needed</p>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-2xl font-semibold tabular-nums">{entry.pallets}</span>
                        <span className="text-xs text-muted-foreground">pallet{entry.pallets !== 1 ? "s" : ""}</span>
                        <span className="text-xs text-muted-foreground ml-auto tabular-nums">{fmt(entry.units)} / {fmt(PALLET_MAX * Math.max(entry.pallets, 1))}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted mb-2 overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.min(100, entry.fillPct)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground mb-2">
                        {entry.pallets > 1
                          ? `${entry.pallets} pallets this month · ${fmt(PALLET_MAX)} cartons each · ${entry.fillPct}% of ${fmt(PALLET_MAX * entry.pallets)} slots`
                          : `${entry.fillPct}% of one ${fmt(PALLET_MAX)} carton pallet`}
                      </p>
                      <div className="space-y-1">
                        {SKUS.map((sku) => {
                          const qty = entry.mix[sku];
                          if (!qty || qty <= 0) return null;
                          const need = idx === 0
                            ? (mfgSkuSummary.find((s) => s.sku === sku)?.inventoryReorder ?? 0)
                            : 0;
                          const short = need > 0 && qty < need;
                          return (
                            <div key={sku} className="flex justify-between text-xs">
                              <span className="text-muted-foreground">{SKU_SHORT[sku]}</span>
                              <span className={`tabular-nums font-medium ${short ? "text-red-500" : ""}`}>
                                {fmt(qty)}
                                {idx === 0 && need > 0 && (
                                  <span className="ml-1 text-[10px] text-muted-foreground">
                                    / {fmt(need)} need
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <p className={`text-[10px] mt-2 ${entry.overdue ? "text-amber-500" : "text-muted-foreground"}`}>
                        {entry.overdue
                          ? `Ship ASAP — missed ${entry.shipBy}`
                          : `Ship by ${entry.shipBy}${entry.arriveBy ? ` · in Amazon ~${entry.arriveBy}` : ""}`}
                      </p>
                    </>
                  )}

                  {sensEntry && (
                    <div className="mt-3 pt-2 border-t text-[10px] text-muted-foreground">
                      <span>actual_2025: </span>
                      {sensEntry.units > 0 ? (
                        <span className="tabular-nums">{fmt(sensEntry.units)} units ({sensEntry.pallets}p)</span>
                      ) : (
                        <span>none</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Transfers */}
          {mfgTransfers.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1">Transfers to FBA (existing warehouse stock)</p>
              <div className="space-y-1">
                {mfgTransfers.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="text-[10px] px-1.5">{t.source}</Badge>
                    <span className="font-medium">{SKU_SHORT[t.sku]}</span>
                    <span className="tabular-nums text-blue-500">{fmt(t.units)}</span>
                    <span className="text-muted-foreground">· {t.timing}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">
            Inventory reorder = (cover target{settings.holiday_mode ? " 90d holiday" : ` ${settings.target_cover_days}d`} + lead) × V30 − on-hand — same as the inventory page.
            {" "}Manufacture = max(inventory reorder, holiday demand − FBA − inbound − AWD{tplOffsetsProduction ? " − 3PL" : ""}).
            {!tplOffsetsProduction && " 3PL is transfer only, does not reduce production."}
            {" "}Nov/Dec/Jan are sell-through months for the manufacturer brief. Current month covers the inventory-page reorder. Sep/Oct pallets carry that Nov–Jan stock so it is in Amazon by {TARGET} (ship-by pulled forward by Recv).
            {" "}A pallet holds {fmt(PALLET_MAX)} cartons; ship 2+ in the same month when the mix does not fit one.
            {" "}FIRM = committed. INDICATIVE = may change. Not a purchase order.
          </p>
        </CardContent>
      </Card>

      {/* Per-SKU table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Per-SKU Holiday Sell-Through vs Supply</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Nov</TableHead>
                <TableHead className="text-right">Dec</TableHead>
                <TableHead className="text-right">Jan</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">FBA</TableHead>
                <TableHead className="text-right">Inbound</TableHead>
                <TableHead className="text-right">AWD</TableHead>
                <TableHead className="text-right">3PL</TableHead>
                <TableHead className="text-right">Supply</TableHead>
                <TableHead className="text-right">Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skuPlans.map((p) => (
                <TableRow key={p.sku}>
                  <TableCell className="font-medium">
                    {p.label}
                    <span className="ml-1 text-[10px] text-muted-foreground">{p.sku}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.novDemand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.decDemand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.janDemand)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmt(p.plannedDemand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.fba)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.inbound)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.awd > 0 ? fmt(p.awd) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.tpl > 0 ? fmt(p.tpl) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.supply)}</TableCell>
                  <TableCell className={`text-right tabular-nums font-medium ${p.gap > 0 ? "text-red-500" : "text-emerald-500"}`}>
                    {p.gap > 0 ? fmt(p.gap) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold bg-muted/30">
                <TableCell>TOTAL</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(skuPlans.reduce((a, p) => a + p.novDemand, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(skuPlans.reduce((a, p) => a + p.decDemand, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(skuPlans.reduce((a, p) => a + p.janDemand, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(totalDemand)}</TableCell>
                <TableCell className="text-right tabular-nums" colSpan={4} />
                <TableCell className="text-right tabular-nums">{fmt(totalSupply)}</TableCell>
                <TableCell className={`text-right tabular-nums ${totalGap > 0 ? "text-red-500" : ""}`}>{totalGap > 0 ? fmt(totalGap) : "—"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Packed 19k pallets across the 3-month plan */}
      {mfgPrimary.entries.some((e) => e.packed.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Pallet Breakdown · {fmt(PALLET_MAX)} cartons each · multiple pallets/month when needed
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pallet</TableHead>
                  {SKUS.map((s) => (
                    <TableHead key={s} className="text-right">{SKU_LABELS[s]?.split(" ")[0]}</TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mfgPrimary.entries.flatMap((entry) =>
                  entry.packed.map((p) => (
                    <TableRow key={`${entry.month}-${p.num}`}>
                      <TableCell className="font-medium">
                        <Package className="inline mr-1 h-3.5 w-3.5 text-muted-foreground" />
                        {entry.label.replace(/ \d{4}$/, "")} P{p.num}
                      </TableCell>
                      {SKUS.map((s) => (
                        <TableCell key={s} className="text-right tabular-nums">
                          {p.mix[s] ? fmt(p.mix[s]) : "—"}
                        </TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmt(p.units)}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          / {fmt(PALLET_MAX)}
                        </span>
                      </TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Next shipment — every packed pallet in month 1 */}
      {mfgPrimary.entries[0] && mfgPrimary.entries[0].units > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Next to ship · {mfgPrimary.entries[0].label}
              {mfgPrimary.entries[0].pallets > 1 ? ` · ${mfgPrimary.entries[0].pallets} pallets` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(mfgPrimary.entries[0].packed.length ? mfgPrimary.entries[0].packed : [{
              num: 1, mix: mfgPrimary.entries[0].mix, units: mfgPrimary.entries[0].units,
            }]).map((p) => (
              <div key={p.num}>
                {mfgPrimary.entries[0].pallets > 1 && (
                  <p className="text-xs font-medium mb-2">
                    Pallet {p.num} · {fmt(p.units)} / {fmt(PALLET_MAX)} cartons
                  </p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {SKUS.filter((sku) => (p.mix[sku] ?? 0) > 0).map((sku) => (
                    <div key={sku} className="rounded-lg border p-3 text-center">
                      <p className="text-xs text-muted-foreground">{SKU_LABELS[sku]}</p>
                      <p className="text-lg font-semibold tabular-nums">{fmt(p.mix[sku])}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Month total {fmt(mfgPrimary.entries[0].units)} cartons · {mfgPrimary.entries[0].pallets} pallet{mfgPrimary.entries[0].pallets !== 1 ? "s" : ""}
              {" · CRITICAL / highest reorder packed first when a month needs more than one"}
              {" · "}
              {mfgPrimary.entries[0].overdue
                ? `Ship ASAP — missed ${mfgPrimary.entries[0].shipBy}`
                : `Ship by ${mfgPrimary.entries[0].shipBy} for receipt ≤ ${TARGET}`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── FBA Cover Projection ── */}
      <Card className={coverAlerts.length > 0 ? "border-red-500/40" : ""}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              {coverAlerts.length > 0 && <AlertTriangle className="h-4 w-4 text-red-500" />}
              FBA Cover Projection — {coverTarget}-Day Target
            </CardTitle>
            <div className="flex gap-1">
              {SKUS.map((s) => {
                const proj = coverProjections.find((p) => p.sku === s);
                const hasFlagged = proj && proj.flaggedCount > 0;
                return (
                  <button key={s} onClick={() => setCoverSku(s)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      coverSku === s ? "bg-primary text-primary-foreground"
                        : hasFlagged ? "bg-red-500/10 text-red-500 hover:bg-red-500/20"
                          : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}>
                    {SKU_SHORT[s]}
                    {hasFlagged && coverSku !== s && <span className="ml-1 text-[10px]">!</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {selectedProj && (
            <>
              <div className="px-4 py-2 text-xs text-muted-foreground flex gap-4">
                <span>FBA start: {fmt(selectedProj.fbaStart)}</span>
                {selectedProj.flaggedCount > 0 && (
                  <span className="text-red-500 font-medium">
                    {selectedProj.flaggedCount} week{selectedProj.flaggedCount !== 1 ? "s" : ""} below {coverTarget}d
                  </span>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Week</TableHead>
                    <TableHead className="text-right">Demand</TableHead>
                    <TableHead className="text-right">Receipt</TableHead>
                    <TableHead className="text-right">FBA On-Hand</TableHead>
                    <TableHead className="text-right">Rate/Day</TableHead>
                    <TableHead className="text-right">Cover</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedProj.weeks.map((w) => (
                    <TableRow key={w.week} className={w.flagged ? "bg-red-500/5" : ""}>
                      <TableCell className="font-medium text-xs">{fmtWeek(w.week)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(w.demand)}</TableCell>
                      <TableCell className="text-right tabular-nums">{w.receipt > 0 ? fmt(w.receipt) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{fmt(w.fba)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{w.dailyRate > 0 ? w.dailyRate.toFixed(1) : "—"}</TableCell>
                      <TableCell className={`text-right tabular-nums font-medium ${
                        w.coverDays === null ? "text-muted-foreground"
                          : w.flagged ? "text-red-500"
                            : w.coverDays < 90 ? "text-amber-500" : "text-emerald-500"
                      }`}>
                        {w.coverDays !== null ? `${w.coverDays}d` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      {/* Cover alerts summary */}
      {coverAlerts.length > 0 && (
        <Card className="border-red-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-red-500 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Cover Shortfall Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {coverAlerts.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Badge variant="destructive" className="text-[10px] px-1.5">{a.coverDays}d</Badge>
                  <span className="font-medium">{SKU_SHORT[a.sku] ?? a.sku}</span>
                  <span className="text-muted-foreground">wk of {fmtWeek(a.week)}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="tabular-nums text-muted-foreground">{fmt(a.fba)} FBA units</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Demand from forecast_weekly (correction_factor scenario), velocity fallback for non-forecast weeks.
        {include3pl ? " 3PL transfer to FBA assumed complete by target date." : " 3PL excluded."}
        {" "}Cover = FBA on-hand / avg daily demand (next {coverTarget} days). Planning aid — not a purchase order.
      </p>
    </div>
  );
}
