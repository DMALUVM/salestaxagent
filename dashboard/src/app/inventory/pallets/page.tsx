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
import { Shield, Package, AlertTriangle, Download, FileText, Lock, Unlock } from "lucide-react";
import Link from "next/link";
import {
  ACTUAL_2025_SOURCE,
  AMAZON_IN_BY,
  PALLET_MAX_UNITS,
  applyAssortedCorrectionDisplay,
  familyTulsaFloor,
  familyYoyMayJul,
  fbaCoverUnits,
  holidayDemandFromSales,
  inAmazonDate,
  inboundInTransit,
  latestRowPerSku,
  monthlyAmazonUnits,
  palletCardSizes,
  palletFill,
  plannerPolicy,
  productionHorizonMonths,
  shipByForMonth,
  skuProductionBuild,
  stampDate,
  workbookWindowUnits,
  type AmazonMonthlySale,
} from "@/lib/pallet-planner-model";
import type { InventoryLeadtimeSummary, InventorySettings } from "@/lib/types";

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

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
}

interface SkuPlan {
  sku: string; label: string; novDecDemand: number; yoy: number;
  fba: number; inbound: number; awd: number; tpl: number; supply: number; gap: number;
}
interface Pallet { num: number; mix: Record<string, number>; total: number; partial?: boolean; }
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
  role?: "gate" | "refill";
  pallets: number; leftoverUnits: number; isPalletCard: boolean;
  fullPallets?: number; hasPartial?: boolean; partialUnits?: number; heldUnits?: number;
  awaitingAugustTotals: boolean; fillPct: number;
  units: number; mix: Record<string, number>; shipBy: string; inAmazon: string;
}
interface MfgScenario { entries: MfgMonthEntry[]; totalUnits: number; totalPallets: number; }
interface MfgSkuSummary {
  sku: string; label: string; holidayDemand: number; yoy: number;
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
  L.push("Section,SKU,SKU_Label,Cover_Target,FBA,Inbound,AWD,TPL,Transfer,Manufacture,Scenario");
  for (const [sc, rows] of [["sales_yoy", skuSummary], ["actual_2025", skuSummarySens]] as const) {
    for (const s of rows) L.push(`SKU_Summary,${s.sku},${s.label},${s.holidayDemand},${s.fba},${s.inbound},${s.awd},${s.tpl},${s.transfer},${s.manufacture},${sc}`);
  }
  L.push(""); L.push("Section,Month,Month_Label,Status,SKU,SKU_Label,Units,Pallets,Ship_By,In_Amazon,Scenario");
  for (const [sc, label] of [[primary, "sales_yoy"], [sensitivity, "actual_2025"]] as const) {
    for (const e of sc.entries) {
      if (!Object.keys(e.mix).length) L.push(`Monthly,${e.month},${e.label},${e.status},,,0,0,${e.shipBy},${e.inAmazon},${label}`);
      for (const [sku, qty] of Object.entries(e.mix)) L.push(`Monthly,${e.month},${e.label},${e.status},${sku},${SKU_LABELS[sku]??sku},${qty},${e.pallets},${e.shipBy},${e.inAmazon},${label}`);
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
  L.push(""); L.push("Cover target = Nov–Jan sales + peak 60d FBA + Feb tail (not Nov–Jan sell-through alone).");
  L.push("Family YoY is context only — not applied as a blended multiplier.");
  L.push(`Pallet capacity: ${fmt(PALLET_MAX)} cartons (270 per 13×11×9 box)`);
  L.push("Fill: two full + one ≥50% partial is fine. Under half is merge-or-hold, not a card.");
  L.push(`FBA cover: fulfillable only · inbound already in transit`);
  L.push(`All holiday units in Amazon FBA by: ${TARGET}`);
  L.push(`3PL policy: transfer only (does NOT reduce manufacture)`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("PER-SKU SUMMARY (sales_yoy)"); L.push("-----------------------------------------------------------------");
  for (const s of skuSummary) {
    L.push(`  ${(SKU_SHORT[s.sku]??s.sku).padEnd(14)} Cover ${fmt(s.holidayDemand).padStart(7)}  FBA ${fmt(s.fba).padStart(6)}  Inb ${fmt(s.inbound).padStart(5)}  AWD ${fmt(s.awd).padStart(5)}  3PL ${fmt(s.tpl).padStart(6)}  Mfg ${fmt(s.manufacture).padStart(7)}`);
  }
  const totalMfg = skuSummary.reduce((a, s) => a + s.manufacture, 0);
  L.push(`  ${"TOTAL".padEnd(14)} ${"".padStart(7)}  ${"".padStart(10)}  ${"".padStart(9)}  ${"".padStart(9)}  ${"".padStart(10)}  Mfg ${fmt(totalMfg).padStart(7)}`);
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("PRODUCTION SCHEDULE — sales_yoy (25%/35%/40%, mix unlocked)"); L.push("-----------------------------------------------------------------");
  for (const e of primary.entries) {
    L.push(""); L.push(`  ${e.label}  —  ${e.status}`);
    if (e.units === 0) { L.push("    No production needed."); continue; }
    if (e.hasPartial) L.push(`    ${e.fullPallets ?? 0} full + 1 partial (${fmt(e.partialUnits ?? 0)} ≥50%)  (${fmt(e.units)} units)`);
    else if (e.isPalletCard) L.push(`    Full pallets: ${e.fullPallets ?? e.pallets}  (${fmt(e.units)} units)`);
    else L.push(`    Held leftover (under half, not a pallet): ${fmt(e.units)} units (${Math.round(e.fillPct * 100)}% of ${fmt(PALLET_MAX)})`);
    for (const sku of SKUS) { const q = e.mix[sku]; if (q && q > 0) L.push(`      ${SKU_LABELS[sku]}: ${fmt(q)} [indicative]`); }
    L.push(`    Ship by: ${e.shipBy} · in Amazon by ${e.inAmazon}`);
    if (e.awaitingAugustTotals) L.push("    August mix unlocked — waiting on Dave's hard totals.");
  }
  L.push(""); L.push(`  TOTAL: ${fmt(primary.totalUnits)} units across ${primary.totalPallets} pallet(s)`);
  if (transfers.length) {
    L.push(""); L.push("-----------------------------------------------------------------");
    L.push("TRANSFERS TO FBA"); L.push("-----------------------------------------------------------------");
    for (const t of transfers) { L.push(`  ${t.source.padEnd(5)} ${(SKU_SHORT[t.sku]??t.sku).padEnd(14)} ${fmt(t.units).padStart(7)} units`); L.push(`        ${t.timing}`); }
  }
  L.push(""); L.push("-----------------------------------------------------------------");
  L.push("SENSITIVITY: actual_2025 (forecast workbook weekly — not Amazon monthly sales)"); L.push("-----------------------------------------------------------------");
  for (const s of skuSummarySens) L.push(`  ${(SKU_SHORT[s.sku]??s.sku).padEnd(14)} Cover ${fmt(s.holidayDemand).padStart(7)}  Mfg ${fmt(s.manufacture).padStart(7)}`);
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
  const awdList = (raw?.awd ?? []) as { sku: string; awd_on_hand: number; pulled_at?: string | null }[];
  const tplList = latestRowPerSku((raw?.tpl ?? []) as { sku: string; available: number; pulled_at?: string | null }[]);
  const velocityList = (raw?.velocity ?? []) as SkuVelocity[];
  const restockList = (raw?.restock ?? []) as { sku: string; pulled_at?: string | null }[];
  const amazonLipSales = (raw?.amazonLipSales ?? []) as AmazonMonthlySale[];
  const settings = (raw as { settings?: InventorySettings | null } | undefined)?.settings;
  const leadtime = (raw as { leadtime?: InventoryLeadtimeSummary | null } | undefined)?.leadtime;
  const policy = useMemo(() => plannerPolicy(settings, leadtime), [settings, leadtime]);
  const salesMonthly = useMemo(
    () => monthlyAmazonUnits(amazonLipSales, SKUS),
    [amazonLipSales],
  );
  const familyYoyCtx = useMemo(() => familyYoyMayJul(salesMonthly, SKUS), [salesMonthly]);
  const salesDemand = useMemo(
    () => applyAssortedCorrectionDisplay(
      holidayDemandFromSales(salesMonthly, SKUS, { includeJan: true }),
      forecasts,
    ),
    [salesMonthly, forecasts],
  );
  const skuBuilds = useMemo(() => {
    const out: Record<string, ReturnType<typeof skuProductionBuild>> = {};
    for (const sku of SKUS) {
      out[sku] = skuProductionBuild(salesDemand[sku] ?? {}, {
        coverDays: policy.targetCoverDays,
        receiveDays: policy.gateReceiveDays,
        optimisticUnits: workbookWindowUnits(forecasts, sku, "optimistic"),
      });
    }
    return out;
  }, [salesDemand, policy, forecasts]);
  const fbaAsOf = stampDate(snapshots.find((s) => s.snapshot_at)?.snapshot_at);
  const awdAsOf = stampDate(awdList.find((a) => a.pulled_at)?.pulled_at);
  const restockAsOf = stampDate(restockList.find((r) => r.pulled_at)?.pulled_at);

  // ── Pallet plan ──
  const { skuPlans, pallets, leftoverUnits, leftoverMix, totalGap, totalDemand, totalSupply } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));
    const sku3pl: Record<string, number> = {};
    for (const sku of SKUS) {
      sku3pl[sku] = include3pl ? Number(tplMap.get(sku)?.available ?? 0) : 0;
    }
    const tulsa = familyTulsaFloor(sku3pl, policy.tulsaFloorUnits);
    const xferShare = tulsa.onHand > 0 ? tulsa.transferable / tulsa.onHand : 0;
    const plans: SkuPlan[] = [];
    let tGap = 0, tDemand = 0, tSupply = 0;
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      const fba = fbaCoverUnits(snap ?? {});
      const inbound = inboundInTransit(snap ?? {});
      const awd = includeAwd ? Number(awdMap.get(sku)?.awd_on_hand ?? 0) : 0;
      const tpl = sku3pl[sku];
      const xfer = Math.round(tpl * xferShare);
      const supply = fba + inbound + awd + xfer;
      const novDecDemand = salesDemand[sku]?.novDecDemand ?? 0;
      const target = skuBuilds[sku]?.skuBuild ?? novDecDemand;
      const gap = Math.max(target - supply, 0);
      tGap += gap; tDemand += target; tSupply += supply;
      plans.push({
        sku, label: SKU_LABELS[sku] ?? sku, novDecDemand,
        yoy: salesDemand[sku]?.yoy ?? 1,
        fba, inbound, awd, tpl, supply, gap,
      });
    }
    tGap += tulsa.topUp;
    const fill = palletFill(tGap, PALLET_MAX);
    const remaining = Object.fromEntries(plans.map((p) => [p.sku, p.gap]));
    const pals: Pallet[] = [];
    for (const [i, size] of palletCardSizes(fill, PALLET_MAX).entries()) {
      const totalRem = Object.values(remaining).reduce((a, b) => a + b, 0);
      if (totalRem <= 0) break;
      const mix: Record<string, number> = {};
      for (const sku of SKUS) {
        if (remaining[sku] <= 0) continue;
        const share = remaining[sku] / totalRem;
        const alloc = Math.min(Math.round(size * share), remaining[sku]);
        if (alloc > 0) { mix[sku] = alloc; remaining[sku] -= alloc; }
      }
      pals.push({
        num: i + 1, mix, total: Object.values(mix).reduce((a, b) => a + b, 0),
        partial: size < PALLET_MAX,
      });
    }
    const leftover: Record<string, number> = {};
    for (const sku of SKUS) if (remaining[sku] > 0) leftover[sku] = remaining[sku];
    return {
      skuPlans: plans, pallets: pals, leftoverUnits: fill.heldUnits, leftoverMix: leftover,
      totalGap: tGap, totalDemand: tDemand, totalSupply: tSupply,
    };
  }, [snapshots, awdList, tplList, include3pl, includeAwd, salesDemand, skuBuilds, policy]);

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
      const fbaStart = fbaCoverUnits(snap ?? {});
      const inboundNow = inboundInTransit(snap ?? {});
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
    const horizon = productionHorizonMonths(
      new Date(), TARGET, policy.gateReceiveDays, policy.peakEndDate, policy.refillReceiveDays,
    );
    const productionMonths = horizon.map((h) => h.month);
    const horizonByMonth = Object.fromEntries(horizon.map((h) => [h.month, h]));

    // Per-SKU inventory (scenario-independent)
    const inv: Record<string, { fba: number; inbound: number; awd: number; tpl: number }> = {};
    for (const sku of SKUS) {
      const snap = snapMap.get(sku);
      inv[sku] = {
        fba: fbaCoverUnits(snap ?? {}),
        inbound: inboundInTransit(snap ?? {}),
        awd: Number(awdMap.get(sku)?.awd_on_hand ?? 0),
        tpl: Number(tplMap.get(sku)?.available ?? 0),
      };
    }

    function buildScenario(demand: Record<string, number>): { sc: MfgScenario; summaries: MfgSkuSummary[] } {
      const summaries: MfgSkuSummary[] = [];
      for (const sku of SKUS) {
        const i = inv[sku];
        const sellthrough = demand[sku] ?? 0;
        const d = skuBuilds[sku]?.skuBuild ?? sellthrough;
        let deductions = i.fba + i.inbound + i.awd;
        if (tplOffsetsProduction) deductions += i.tpl;
        const manufacture = Math.max(0, d - deductions);
        summaries.push({
          sku, label: SKU_LABELS[sku] ?? sku, holidayDemand: d,
          yoy: salesDemand[sku]?.yoy ?? 1,
          fba: i.fba, inbound: i.inbound, awd: i.awd, tpl: i.tpl,
          transfer: i.tpl + i.awd, manufacture,
        });
      }

      const gateMonths = horizon.filter((h) => h.role === "gate").map((h) => h.month);
      const refillMonths = horizon.filter((h) => h.role === "refill").map((h) => h.month);
      const remainingGate: Record<string, number> = {};
      const remainingRefill: Record<string, number> = {};
      for (const s of summaries) {
        const b = skuBuilds[s.sku];
        const g = b?.gateUnits ?? 0;
        const r = (b?.refillUnits ?? 0);
        const tot = g + r;
        if (tot <= 0) {
          remainingGate[s.sku] = 0;
          remainingRefill[s.sku] = s.manufacture;
        } else {
          remainingGate[s.sku] = Math.min(Math.round(s.manufacture * g / tot), s.manufacture);
          remainingRefill[s.sku] = s.manufacture - remainingGate[s.sku];
        }
      }
      const entries: MfgMonthEntry[] = [];
      for (const m of productionMonths) {
        const h = horizonByMonth[m];
        const role = h?.role ?? "gate";
        const recv = h?.receiveDays ?? policy.gateReceiveDays;
        const pool = role === "gate" ? remainingGate : remainingRefill;
        const roleMonths = role === "gate" ? gateMonths : refillMonths;
        const mi = roleMonths.indexOf(m);
        const lastInRole = mi === roleMonths.length - 1;
        const w = role === "gate" ? (MFG_WEIGHTS[mi] ?? 0) : 1 / Math.max(roleMonths.length, 1);
        const wSum = role === "gate"
          ? MFG_WEIGHTS.slice(mi, roleMonths.length).reduce((a, b) => a + b, 0)
          : Math.max(roleMonths.length - mi, 1);
        const mix: Record<string, number> = {};
        for (const sku of SKUS) {
          if (pool[sku] <= 0) continue;
          const alloc = lastInRole
            ? pool[sku]
            : Math.min(Math.round(pool[sku] * w / Math.max(wSum, 0.01)), pool[sku]);
          if (alloc > 0) { mix[sku] = alloc; pool[sku] -= alloc; }
        }
        const total = Object.values(mix).reduce((a, b) => a + b, 0);
        const fill = palletFill(total, PALLET_MAX);
        const shipBy = shipByForMonth(m, TARGET, recv, {
          role,
          needInFba: role === "refill" ? policy.peakEndDate : undefined,
        });
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const latest = role === "gate" ? TARGET : policy.peakEndDate;
        entries.push({
          month: m, label: monthLabel(m), role,
          status: committed.has(m) ? "FIRM" : "INDICATIVE",
          pallets: fill.palletCards,
          fullPallets: fill.fullPallets,
          leftoverUnits: fill.leftoverUnits,
          heldUnits: fill.heldUnits,
          partialUnits: fill.partialUnits,
          hasPartial: fill.hasPartial,
          isPalletCard: fill.isPalletCard,
          awaitingAugustTotals: m === currentMonth && now.getMonth() === 7,
          fillPct: fill.fillPct,
          units: total, mix, shipBy,
          inAmazon: inAmazonDate(shipBy, recv, latest, { clamp: role === "gate" }),
        });
      }
      return {
        sc: { entries, totalUnits: entries.reduce((a, e) => a + e.units, 0), totalPallets: entries.reduce((a, e) => a + e.pallets, 0) },
        summaries,
      };
    }

    const salesHoliday: Record<string, number> = {};
    for (const sku of SKUS) salesHoliday[sku] = salesDemand[sku]?.holidayDemand ?? 0;
    const prim = buildScenario(salesHoliday);
    const sens = buildScenario(holidayDemandBySku(forecasts, "actual_2025"));

    // Transfers (scenario-independent)
    const transfers: MfgTransfer[] = [];
    for (const sku of SKUS) {
      const i = inv[sku];
      if (i.awd > 0) transfers.push({ sku, source: "AWD", units: i.awd, timing: "Transfer to FBA immediately (~2 weeks)" });
      const tulsa = familyTulsaFloor(Object.fromEntries(SKUS.map((s) => [s, inv[s].tpl])), policy.tulsaFloorUnits);
      const xfer = tulsa.onHand > 0 ? Math.round(i.tpl * (tulsa.transferable / tulsa.onHand)) : 0;
              if (xfer > 0) transfers.push({ sku, source: "3PL", units: xfer, timing: `Excess above Tulsa floor (${policy.tulsaFloorUnits.toLocaleString()} lip family) by ${policy.earlyJanFbaShipBy} — keep 5k after outbound; do not drain 3PL to 0` });
    }

    return {
      mfgPrimary: prim.sc, mfgSensitivity: sens.sc,
      mfgSkuSummary: prim.summaries, mfgSkuSummarySens: sens.summaries,
      mfgTransfers: transfers,
    };
  }, [snapshots, forecasts, awdList, tplList, committed, tplOffsetsProduction, salesDemand, skuBuilds, policy]);

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
            Lip Balm holiday build · each SKU: 2025 same-month Amazon × that SKU&apos;s own May–Jul YoY · Q4/early-Jan receive {policy.gateReceiveDays}d · In Amazon by {TARGET}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Dated stamps (not “today”): FBA {fbaAsOf ?? "—"}
            {awdAsOf ? ` · AWD ${awdAsOf}` : ""}
            {restockAsOf ? ` · Restock ${restockAsOf}` : ""}
            {familyYoyCtx.yoy
              ? ` · Family YoY ${familyYoyCtx.yoy.toFixed(2)}× (context only, not applied)`
              : ""}
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
            <p className="text-[10px] text-muted-foreground uppercase">Nov+Dec Demand</p>
            <p className="text-2xl font-semibold tabular-nums">{fmt(totalDemand)}</p>
            <p className="text-xs text-muted-foreground">each SKU&apos;s own May–Jul YoY</p>
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
              Cover target = Nov–Jan sales + peak 60d FBA + Feb tail — not Nov–Jan sell-through alone. Mix unlocked. Family 1.42× is context only. actual_2025 is the forecast workbook weekly column — not monthly Amazon sales.
            </p>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Unchecked: manufacture = cover-target − FBA − inbound − AWD (3PL ignored)">
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
                  <TableHead className="text-right">Own YoY</TableHead>
                  <TableHead className="text-right" title="Nov–Jan sales + peak 60d FBA + Feb tail">Cover target</TableHead>
                  <TableHead className="text-right">FBA fulfillable</TableHead>
                  <TableHead className="text-right">Inbound (in transit)</TableHead>
                  <TableHead className="text-right">AWD</TableHead>
                  <TableHead className="text-right">3PL</TableHead>
                  <TableHead className="text-right">Transfer</TableHead>
                  <TableHead className="text-right font-semibold">Manufacture</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mfgSkuSummary.map((s) => (
                  <TableRow key={s.sku}>
                    <TableCell className="font-medium text-xs">{SKU_SHORT[s.sku]}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{s.yoy.toFixed(2)}×</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(s.holidayDemand)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.fba)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.inbound > 0 ? fmt(s.inbound) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.awd > 0 ? fmt(s.awd) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{s.tpl > 0 ? fmt(s.tpl) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-blue-500">{s.transfer > 0 ? fmt(s.transfer) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-primary">{fmt(s.manufacture)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell>TOTAL</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{fmt(mfgSkuSummary.reduce((a, s) => a + s.holidayDemand, 0))}</TableCell>
                  <TableCell colSpan={4} />
                  <TableCell className="text-right tabular-nums text-blue-500">{fmt(mfgSkuSummary.reduce((a, s) => a + s.transfer, 0))}</TableCell>
                  <TableCell className="text-right tabular-nums text-primary">{fmt(mfgSkuSummary.reduce((a, s) => a + s.manufacture, 0))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

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
                      {entry.hasPartial ? (
                        <div className="mb-2">
                          <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-semibold tabular-nums">{entry.pallets}</span>
                            <span className="text-xs text-muted-foreground">
                              pallet{(entry.pallets ?? 0) !== 1 ? "s" : ""} · {entry.fullPallets ?? 0} full + 1 partial
                            </span>
                            <span className="text-xs text-muted-foreground ml-auto tabular-nums">{fmt(entry.units)} units</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Partial {fmt(entry.partialUnits ?? 0)} (≥50% of {fmt(PALLET_MAX)})
                          </p>
                        </div>
                      ) : entry.isPalletCard ? (
                        <div className="flex items-baseline gap-2 mb-2">
                          <span className="text-2xl font-semibold tabular-nums">{entry.fullPallets ?? entry.pallets}</span>
                          <span className="text-xs text-muted-foreground">full pallet{(entry.fullPallets ?? entry.pallets) !== 1 ? "s" : ""}</span>
                          <span className="text-xs text-muted-foreground ml-auto tabular-nums">{fmt(entry.units)} units</span>
                        </div>
                      ) : (
                        <div className="mb-2">
                          <p className="text-xs font-medium">Held leftover — under half a pallet</p>
                          <p className="text-2xl font-semibold tabular-nums">{fmt(entry.units)}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {Math.round(entry.fillPct * 100)}% of {fmt(PALLET_MAX)} · merge or hold, not a pallet
                          </p>
                        </div>
                      )}
                      {(entry.heldUnits ?? 0) > 0 && entry.isPalletCard && (
                        <p className="text-[10px] text-muted-foreground mb-2">
                          + {fmt(entry.heldUnits ?? 0)} held leftover (under half, not a pallet)
                        </p>
                      )}
                      <div className="space-y-1">
                        {SKUS.map((sku) => {
                          const qty = entry.mix[sku];
                          if (!qty || qty <= 0) return null;
                          return (
                            <div key={sku} className="flex justify-between text-xs">
                              <span className="text-muted-foreground">{SKU_SHORT[sku]} <span className="text-[9px]">indicative</span></span>
                              <span className="tabular-nums font-medium">{fmt(qty)}</span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2">
                        {entry.role === "refill"
                          ? `Post-Christmas ammo · early-Jan FBA ship by ${policy.earlyJanFbaShipBy} · ${entry.shipBy}`
                          : `Ship by ${entry.shipBy} · in Amazon by ${entry.inAmazon}`}
                      </p>
                      {entry.awaitingAugustTotals && (
                        <p className="text-[10px] text-amber-600 mt-1">
                          August mix unlocked — Dave sends hard totals. Holt owns Sep–Nov after those land.
                        </p>
                      )}
                    </>
                  )}

                  {sensEntry && (
                    <div className="mt-3 pt-2 border-t text-[10px] text-muted-foreground">
                      <span title={ACTUAL_2025_SOURCE}>workbook weekly 2025-actual (not monthly sales): </span>
                      {sensEntry.units > 0 ? (
                        <span className="tabular-nums">
                          {fmt(sensEntry.units)} units
                          {sensEntry.hasPartial
                            ? ` (${sensEntry.fullPallets ?? 0} full + 1 partial)`
                            : sensEntry.isPalletCard ? ` (${sensEntry.pallets}p)` : " held leftover"}
                        </span>
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
            Manufacture = cover-target − FBA fulfillable − inbound already in transit − AWD{tplOffsetsProduction ? " − 3PL" : ""}.
            {!tplOffsetsProduction && " 3PL is transfer only (ignored in manufacture)."}
            {" "}Mix is unlocked. Two full + one ≥50% partial is fine. Under half a pallet is merge-or-hold, not a card. FIRM = committed. INDICATIVE = may change. Not a purchase order.
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
                <TableHead className="text-right">Own YoY</TableHead>
                <TableHead className="text-right">Nov+Dec (own YoY)</TableHead>
                <TableHead className="text-right">FBA fulfillable</TableHead>
                <TableHead className="text-right">Inbound (in transit)</TableHead>
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
                  <TableCell className="text-right tabular-nums text-muted-foreground">{p.yoy.toFixed(2)}×</TableCell>
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
                <TableCell />
                <TableCell className="text-right tabular-nums">{fmt(totalDemand)}</TableCell>
                <TableCell className="text-right tabular-nums" colSpan={4} />
                <TableCell className="text-right tabular-nums">{fmt(totalSupply)}</TableCell>
                <TableCell className={`text-right tabular-nums ${totalGap > 0 ? "text-red-500" : ""}`}>{totalGap > 0 ? fmt(totalGap) : "—"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Under-half leftover — merge or hold, never a pallet card */}
      {leftoverUnits > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Held leftover — under half a pallet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{fmt(leftoverUnits)}</p>
            <p className="text-xs text-muted-foreground">
              {Math.round((leftoverUnits / PALLET_MAX) * 100)}% of a {fmt(PALLET_MAX)}-carton Marpac pallet.
              Merge or hold — not a pallet. Dave sends hard August totals — mix not locked.
            </p>
            <div className="mt-2 space-y-1">
              {SKUS.map((sku) => {
                const qty = leftoverMix[sku];
                if (!qty) return null;
                return (
                  <div key={sku} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{SKU_SHORT[sku]} indicative</span>
                    <span className="tabular-nums">{fmt(qty)}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

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
                      Pallet {p.num}{p.partial ? " · partial" : ""}
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
              Total: {fmt(pallets[0].total)} units · Indicative mix, not locked · in Amazon by {TARGET}
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
        Holiday demand = each SKU&apos;s 2025 same-month Amazon × that SKU&apos;s own May–Jul YoY (family 1.42× is context only; not actual_2025 workbook weekly).
        Cover starts from FBA fulfillable only. Inbound is already in transit — do not send it again.
        {include3pl ? " 3PL is latest row per SKU." : " 3PL excluded."}
        {" "}Holiday inbound dates honor {TARGET}. Planning aid — not a purchase order. Mix unlocked.
      </p>
    </div>
  );
}
