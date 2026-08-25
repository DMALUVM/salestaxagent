"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useInventory } from "@/lib/hooks";
import type { InventorySnapshot, SkuVelocity } from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import { FourNumbersSummary } from "@/components/inventory/FourNumbersSummary";
import { useFourNumbersPlan } from "@/lib/use-four-numbers-plan";
import { Shield, Package, AlertTriangle, Download, FileText, Lock, Unlock } from "lucide-react";
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
const PALLET_MAX = 19_000;
const TARGET = "2026-10-31";
const COVER_TARGET = 60;
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
  sku: string; label: string; novDecDemand: number;
  fba: number; inbound: number; awd: number; tpl: number; supply: number; gap: number;
}
interface Pallet { num: number; mix: Record<string, number>; total: number; }
interface CoverWeek {
  week: string; fba: number; demand: number; receipt: number;
  dailyRate: number; coverDays: number | null; flagged: boolean;
}
interface SkuProjection {
  sku: string; label: string; fbaStart: number;
  weeks: CoverWeek[]; flaggedCount: number;
}
interface MfgMonthEntry {
  month: string; label: string; status: "FIRM" | "INDICATIVE";
  pallets: number; units: number; mix: Record<string, number>; shipBy: string;
}
interface MfgScenario { entries: MfgMonthEntry[]; totalUnits: number; totalPallets: number; }
interface MfgSkuSummary {
  sku: string; label: string; holidayDemand: number;
  fba: number; inbound: number; awd: number; tpl: number;
  transfer: number; manufacture: number;
}
interface MfgTransfer { sku: string; source: string; units: number; timing: string; }

const MFG_WEIGHTS = [0.25, 0.35, 0.40];
const HOLIDAY_MONTHS = new Set(["2026-11", "2026-12", "2026-01", "2027-01"]);

function getMonday(d: Date): Date {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff);
}
function toIso(d: Date): string { return d.toISOString().slice(0, 10); }

function holidayDemandBySku(
  forecasts: { sku: string; week_start: string; scenario: string; units: number }[],
  scenario: string,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const sku of SKUS) totals[sku] = 0;
  for (const f of forecasts) {
    if (f.scenario !== scenario) continue;
    const m = f.week_start?.slice(0, 7);
    if (m && HOLIDAY_MONTHS.has(m)) totals[f.sku] = (totals[f.sku] ?? 0) + Number(f.units);
  }
  for (const sku of SKUS) totals[sku] = Math.round(totals[sku] ?? 0);
  return totals;
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
  L.push("Section,SKU,SKU_Label,Holiday_Demand,FBA,Inbound,AWD,TPL,Transfer,Manufacture,Scenario");
  for (const [sc, rows] of [["correction_factor", skuSummary], ["actual_2025", skuSummarySens]] as const) {
    for (const s of rows) L.push(`SKU_Summary,${s.sku},${s.label},${s.holidayDemand},${s.fba},${s.inbound},${s.awd},${s.tpl},${s.transfer},${s.manufacture},${sc}`);
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
  L.push(""); L.push(`Demand period: Nov + Dec + Jan`);
  L.push(`Pallet capacity: ${fmt(PALLET_MAX)} units`);
  L.push(`FBA cover target: ${COVER_TARGET} days forward stock`);
  L.push(`All units in Amazon FBA by: ${TARGET}`);
  L.push(`3PL policy: transfer only (does NOT reduce manufacture)`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("PER-SKU SUMMARY (correction_factor)"); L.push("-----------------------------------------------------------------");
  for (const s of skuSummary) {
    L.push(`  ${(SKU_SHORT[s.sku]??s.sku).padEnd(14)} Demand ${fmt(s.holidayDemand).padStart(7)}  FBA ${fmt(s.fba).padStart(6)}  Inb ${fmt(s.inbound).padStart(5)}  AWD ${fmt(s.awd).padStart(5)}  3PL ${fmt(s.tpl).padStart(6)}  Mfg ${fmt(s.manufacture).padStart(7)}`);
  }
  const totalMfg = skuSummary.reduce((a, s) => a + s.manufacture, 0);
  L.push(`  ${"TOTAL".padEnd(14)} ${"".padStart(7)}  ${"".padStart(10)}  ${"".padStart(9)}  ${"".padStart(9)}  ${"".padStart(10)}  Mfg ${fmt(totalMfg).padStart(7)}`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("PRODUCTION SCHEDULE — correction_factor (25%/35%/40%)"); L.push("-----------------------------------------------------------------");
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
  L.push("NOTES:"); L.push("  - FIRM = committed. INDICATIVE = forecast-driven, may change.");
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

  const { plan: supplyPlan } = useFourNumbersPlan({
    skus: SKUS,
    raw: raw ?? undefined,
  });
  const supplyBySku = useMemo(() => {
    const m = new Map<string, NonNullable<typeof supplyPlan>["skuRows"][number]>();
    if (supplyPlan) for (const r of supplyPlan.skuRows) m.set(r.sku, r);
    return m;
  }, [supplyPlan]);

  // ── Pallet plan ──
  const { skuPlans, pallets, totalGap, totalDemand, totalSupply } = useMemo(() => {
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
      let novDecDemand = 0;
      for (const f of forecasts) {
        if (f.sku !== sku || f.scenario !== "correction_factor") continue;
        const m = f.week_start?.slice(0, 7);
        if (m === "2026-11" || m === "2026-12") novDecDemand += Number(f.units);
      }
      novDecDemand = Math.round(novDecDemand);
      const gap = Math.max(novDecDemand - supply, 0);
      tGap += gap; tDemand += novDecDemand; tSupply += supply;
      plans.push({ sku, label: SKU_LABELS[sku] ?? sku, novDecDemand, fba, inbound, awd, tpl, supply, gap });
    }
    const numPallets = tGap > 0 ? Math.ceil(tGap / PALLET_MAX) : 0;
    const remaining = Object.fromEntries(plans.map((p) => [p.sku, p.gap]));
    const pals: Pallet[] = [];
    for (let i = 0; i < numPallets; i++) {
      const totalRem = Object.values(remaining).reduce((a, b) => a + b, 0);
      if (totalRem <= 0) break;
      const palletUnits = Math.min(PALLET_MAX, totalRem);
      const mix: Record<string, number> = {};
      for (const sku of SKUS) {
        if (remaining[sku] <= 0) continue;
        const share = remaining[sku] / totalRem;
        const alloc = Math.min(Math.round(palletUnits * share), remaining[sku]);
        if (alloc > 0) { mix[sku] = alloc; remaining[sku] -= alloc; }
      }
      pals.push({ num: i + 1, mix, total: Object.values(mix).reduce((a, b) => a + b, 0) });
    }
    return { skuPlans: plans, pallets: pals, totalGap: tGap, totalDemand: tDemand, totalSupply: tSupply };
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
          flagged = coverDays !== null && coverDays < COVER_TARGET;
        }
        if (flagged) { flaggedCount++; alerts.push({ sku, week: wIso, coverDays: coverDays!, fba: Math.round(fba) }); }
        weekData.push({ week: wIso, fba: Math.round(fba), demand: Math.round(demand), receipt, dailyRate: Math.round(dailyRate * 10) / 10, coverDays, flagged });
      }
      projections.push({ sku, label: SKU_LABELS[sku] ?? sku, fbaStart, weeks: weekData, flaggedCount });
    }
    return { coverProjections: projections, coverAlerts: alerts };
  }, [snapshots, forecasts, awdList, tplList, velocityList, include3pl, includeAwd]);

  // ── Manufacturer Heads-Up (demand - FBA - inbound - AWD; 3PL = transfer only) ──
  const [tplOffsetsProduction, setTplOffsetsProduction] = useState(false);

  const { mfgPrimary, mfgSensitivity, mfgSkuSummary, mfgSkuSummarySens, mfgTransfers } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));
    const productionMonths = getMonthList(new Date(), 3);

    // Per-SKU inventory (scenario-independent)
    const inv: Record<string, { fba: number; inbound: number; awd: number; tpl: number }> = {};
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      inv[sku] = {
        fba: Number(snap?.fulfillable ?? 0) + Number(snap?.reserved ?? 0) +
          Number(snap?.researching ?? 0) + Number(snap?.unfulfillable ?? 0),
        inbound: Number(snap?.inbound_working ?? 0) + Number(snap?.inbound_shipped ?? 0) +
          Number(snap?.inbound_receiving ?? 0),
        awd: Number(awdMap.get(sku)?.awd_on_hand ?? 0),
        tpl: Number(tplMap.get(sku)?.available ?? 0),
      };
    }

    function buildScenario(scenario: string): { sc: MfgScenario; summaries: MfgSkuSummary[] } {
      const demand = holidayDemandBySku(forecasts, scenario);
      const summaries: MfgSkuSummary[] = [];
      for (const sku of SKUS) {
        const i = inv[sku];
        const d = demand[sku] ?? 0;
        let deductions = i.fba + i.inbound + i.awd;
        if (tplOffsetsProduction) deductions += i.tpl;
        const manufacture = Math.max(0, d - deductions);
        summaries.push({
          sku, label: SKU_LABELS[sku] ?? sku, holidayDemand: d,
          fba: i.fba, inbound: i.inbound, awd: i.awd, tpl: i.tpl,
          transfer: i.tpl + i.awd, manufacture,
        });
      }

      // Distribute manufacture across months using weights
      const remaining: Record<string, number> = {};
      for (const s of summaries) remaining[s.sku] = s.manufacture;
      const entries: MfgMonthEntry[] = [];
      for (let mi = 0; mi < productionMonths.length; mi++) {
        const m = productionMonths[mi];
        const w = MFG_WEIGHTS[mi] ?? 0;
        const wSum = MFG_WEIGHTS.slice(mi).reduce((a, b) => a + b, 0);
        const mix: Record<string, number> = {};
        for (const sku of SKUS) {
          if (remaining[sku] <= 0) continue;
          const alloc = mi === productionMonths.length - 1
            ? remaining[sku]
            : Math.min(Math.round(remaining[sku] * w / Math.max(wSum, 0.01)), remaining[sku]);
          if (alloc > 0) { mix[sku] = alloc; remaining[sku] -= alloc; }
        }
        const total = Object.values(mix).reduce((a, b) => a + b, 0);
        entries.push({
          month: m, label: monthLabel(m),
          status: committed.has(m) ? "FIRM" : "INDICATIVE",
          pallets: total > 0 ? Math.ceil(total / PALLET_MAX) : 0,
          units: total, mix, shipBy: `${m}-20`,
        });
      }
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

    return {
      mfgPrimary: prim.sc, mfgSensitivity: sens.sc,
      mfgSkuSummary: prim.summaries, mfgSkuSummarySens: sens.summaries,
      mfgTransfers: transfers,
    };
  }, [snapshots, forecasts, awdList, tplList, committed, tplOffsetsProduction]);

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
            Lip Balm holiday build · Nov+Dec demand · In Amazon by {TARGET}
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

      {supplyPlan && <FourNumbersSummary plan={supplyPlan} />}

      {/* Summary cards — pallet Nov+Dec view + FBA cover alerts */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Nov+Dec Demand</p>
            <p className="text-2xl font-semibold tabular-nums">{fmt(totalDemand)}</p>
            <p className="text-xs text-muted-foreground">correction_factor</p>
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
            <p className="text-[10px] text-muted-foreground uppercase">Gap to Produce</p>
            <p className={`text-2xl font-semibold tabular-nums ${totalGap > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {totalGap > 0 ? fmt(totalGap) : "Covered"}
            </p>
          </CardContent>
        </Card>
        <Card className={coverAlerts.length > 0 ? "border-red-500/40" : "border-emerald-500/40"}>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">FBA Cover Alerts</p>
            <p className={`text-2xl font-semibold tabular-nums ${coverAlerts.length > 0 ? "text-red-500" : "text-emerald-500"}`}>
              {coverAlerts.length > 0 ? coverAlerts.length : "OK"}
            </p>
            <p className="text-xs text-muted-foreground">weeks &lt; {COVER_TARGET}d</p>
          </CardContent>
        </Card>
      </div>

      {/* ══════ SHARE WITH MANUFACTURER ══════ */}
      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Share with Manufacturer</CardTitle>
            <div className="flex gap-2">
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
              Manufacture column uses shared supply plan (YoY holiday · lip 6w / balm 10w lead).
              Monthly schedule below is correction_factor sensitivity.
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
                  <TableHead className="text-right">Demand</TableHead>
                  <TableHead className="text-right">FBA</TableHead>
                  <TableHead className="text-right">Inbound</TableHead>
                  <TableHead className="text-right">AWD</TableHead>
                  <TableHead className="text-right">3PL</TableHead>
                  <TableHead className="text-right">Transfer</TableHead>
                  <TableHead className="text-right font-semibold">Manufacture</TableHead>
                  <TableHead>Order by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mfgSkuSummary.map((s) => {
                  const supply = supplyBySku.get(s.sku);
                  const mfgQty = supply?.manufactureQty ?? s.manufacture;
                  return (
                  <TableRow key={s.sku}>
                    <TableCell className="font-medium text-xs">{SKU_SHORT[s.sku]}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {fmt(supply?.holidayDemand ?? s.holidayDemand)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.fba)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.inbound > 0 ? fmt(s.inbound) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.awd > 0 ? fmt(s.awd) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{s.tpl > 0 ? fmt(s.tpl) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-blue-500">
                      {fmt(supply?.shipToFba ?? s.transfer)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-primary">{fmt(mfgQty)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {supply?.orderBy?.slice(5) ?? "—"}
                    </TableCell>
                  </TableRow>
                  );
                })}
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell>TOTAL</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.holidayDemand, 0))}</TableCell>
                  <TableCell colSpan={4} />
                  <TableCell className="text-right tabular-nums text-blue-500">
                    {fmt(supplyPlan?.totalWarehouseShipFba ?? mfgSkuSummary.reduce((a, s) => a + s.transfer, 0))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-primary">
                    {fmt(supplyPlan?.totalManufacture ?? mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0))}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {supplyPlan && supplyPlan.wavesConsolidated.length > 0 && (
            <div className="rounded-lg border p-3 space-y-2">
              <p className="text-xs font-medium">Warehouse ship schedule (shared plan · 3PL → FBA)</p>
              {supplyPlan.wavesConsolidated.map((w) => (
                <div key={w.ship_by} className="flex justify-between text-xs">
                  <span className={w.urgent ? "text-red-600 font-medium" : ""}>
                    Ship by {w.ship_by}{w.urgent ? " URGENT" : ""}
                  </span>
                  <span className="tabular-nums font-medium">{fmt(w.total_units)} units</span>
                </div>
              ))}
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
                      <Badge variant={isFirm ? "default" : "secondary"} className="text-[10px] mt-0.5">
                        {entry.status}
                      </Badge>
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
                        <span className="text-xs text-muted-foreground ml-auto tabular-nums">{fmt(entry.units)} units</span>
                      </div>
                      <div className="space-y-1">
                        {SKUS.map((sku) => {
                          const qty = entry.mix[sku];
                          if (!qty || qty <= 0) return null;
                          return (
                            <div key={sku} className="flex justify-between text-xs">
                              <span className="text-muted-foreground">{SKU_SHORT[sku]}</span>
                              <span className="tabular-nums font-medium">{fmt(qty)}</span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2">Ship by {entry.shipBy}</p>
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
            Manufacture = demand - FBA - inbound - AWD{tplOffsetsProduction ? " - 3PL" : ""}.
            {!tplOffsetsProduction && " 3PL is transfer only, does not reduce production."}
            {" "}FIRM = committed. INDICATIVE = may change. Not a purchase order.
          </p>
        </CardContent>
      </Card>

      {/* Per-SKU table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Per-SKU Holiday Demand vs Supply</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Nov+Dec</TableHead>
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
                  <TableCell className="text-right tabular-nums font-medium">{fmt(p.novDecDemand)}</TableCell>
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
                <TableCell className="text-right tabular-nums">{fmt(totalDemand)}</TableCell>
                <TableCell className="text-right tabular-nums" colSpan={4} />
                <TableCell className="text-right tabular-nums">{fmt(totalSupply)}</TableCell>
                <TableCell className={`text-right tabular-nums ${totalGap > 0 ? "text-red-500" : ""}`}>{totalGap > 0 ? fmt(totalGap) : "—"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pallet breakdown */}
      {pallets.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Pallet Breakdown</CardTitle>
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
                {pallets.map((p) => (
                  <TableRow key={p.num}>
                    <TableCell className="font-medium">
                      <Package className="inline mr-1 h-3.5 w-3.5 text-muted-foreground" />
                      Pallet {p.num}
                    </TableCell>
                    {SKUS.map((s) => (
                      <TableCell key={s} className="text-right tabular-nums">
                        {p.mix[s] ? fmt(p.mix[s]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums font-medium">{fmt(p.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Next pallet card */}
      {pallets.length > 0 && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Next Pallet to Order</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Object.entries(pallets[0].mix).map(([sku, qty]) => (
                <div key={sku} className="rounded-lg border p-3 text-center">
                  <p className="text-xs text-muted-foreground">{SKU_LABELS[sku]}</p>
                  <p className="text-lg font-semibold tabular-nums">{fmt(qty)}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Total: {fmt(pallets[0].total)} units · Ship ASAP for receipt ≤ {TARGET}
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
              FBA Cover Projection — {COVER_TARGET}-Day Target
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
                    {selectedProj.flaggedCount} week{selectedProj.flaggedCount !== 1 ? "s" : ""} below {COVER_TARGET}d
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
        {" "}Cover = FBA on-hand / avg daily demand (next {COVER_TARGET} days). Planning aid — not a purchase order.
      </p>
    </div>
  );
}
