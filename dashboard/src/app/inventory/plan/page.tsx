"use client";

import { useEffect, useMemo, useState } from "react";
import { useInventory } from "@/lib/hooks";
import type {
  InventorySnapshot,
  SkuVelocity,
  SeasonalityWeekly,
} from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import { planningDaily } from "@/lib/pallet-plan";
import { Shield, AlertTriangle, Play } from "lucide-react";
import Link from "next/link";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
}

interface WeekRow {
  week: number;
  start: string;
  end: string;
  mult: number;
  demand: number;
  remaining: number;
  status: string;
}

interface PlanResult {
  totalDemand: number;
  fbaSupply: number;
  ownedTotal: number;
  fbaGap: number;
  produceGap: number;
  stockoutDate: string | null;
  stockoutDays: number | null;
  weeks: WeekRow[];
  transferFromTpl: number;
  transferFromAwd: number;
  produce: number;
  avgDailyHorizon: number;
  baseDailyV30: number;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PlanSkuPage() {
  const { data: raw, loading } = useInventory();
  const [selectedSku, setSelectedSku] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("sku") ?? "";
  });
  const [autoRan, setAutoRan] = useState(false);
  const [untilDate, setUntilDate] = useState("2027-01-15");
  const [bufferDays, setBufferDays] = useState(14);
  const [useAwd, setUseAwd] = useState(true);
  const [include3pl, setInclude3pl] = useState(false);
  const [stress, setStress] = useState(1.0);
  const [ran, setRan] = useState(false);

  const snapshots = (raw?.snapshots ?? []) as InventorySnapshot[];
  const velocities = (raw?.velocity ?? []) as SkuVelocity[];
  const seasonality = (raw?.seasonality ?? []) as SeasonalityWeekly[];
  const awdList = (raw?.awd ?? []) as { sku: string; awd_on_hand: number }[];
  const tplList = (raw?.tpl ?? []) as { sku: string; available: number }[];
  const forecastRows = (raw?.forecast ?? []) as { sku: string; week_start: string; scenario: string; units: number }[];

  const skuOptions = useMemo(() => {
    const set = new Set([
      ...snapshots.map((s) => s.sku),
      ...velocities.map((v) => v.sku),
    ]);
    return Array.from(set).sort();
  }, [snapshots, velocities]);

  const plan = useMemo((): PlanResult | null => {
    if (!ran || !selectedSku) return null;

    const snap = snapshots.find((s) => s.sku === selectedSku);
    const vel = velocities.find((v) => v.sku === selectedSku);
    const awdItem = awdList.find((a) => a.sku === selectedSku);
    const tplItem = tplList.find((t) => t.sku === selectedSku);

    const baseDaily = Number(vel?.total_u_30 ?? 0);
    if (baseDaily <= 0) return null;

    const seasonMap = new Map<number, number>();
    for (const s of seasonality)
      seasonMap.set(Number(s.week), Number(s.multiplier));

    // Holiday forecast: prefer imported weekly series when available
    const skuForecast = forecastRows.filter((f) => f.sku === selectedSku);
    // Build sorted array of forecast weeks for range lookup
    const scenarioKey = "correction_factor";
    const forecastWeeks: { start: number; units: number }[] = [];
    for (const f of skuForecast) {
      if (f.scenario === scenarioKey) {
        forecastWeeks.push({
          start: new Date(f.week_start + "T00:00:00").getTime(),
          units: Number(f.units),
        });
      }
    }
    forecastWeeks.sort((a, b) => a.start - b.start);
    const hasForecast = forecastWeeks.length > 0;

    // Find forecast that overlaps the plan week [cursorMs, endMs].
    // Uses the closest forecast week_start by overlap.
    function getForecastDemand(cursorMs: number, endMs: number): number | null {
      let best: number | null = null;
      let bestDist = Infinity;
      for (const fw of forecastWeeks) {
        const fwEnd = fw.start + 6 * 86400000;
        // Overlap: forecast [fw.start, fwEnd] intersects plan [cursorMs, endMs]
        if (fw.start <= endMs && fwEnd >= cursorMs) {
          const dist = Math.abs(fw.start - cursorMs);
          if (dist < bestDist) {
            best = fw.units;
            bestDist = dist;
          }
        }
      }
      return best;
    }

    const fba =
      Number(snap?.fulfillable ?? 0) +
      Number(snap?.reserved ?? 0) +
      Number(snap?.researching ?? 0) +
      Number(snap?.unfulfillable ?? 0);
    const inbound =
      Number(snap?.inbound_working ?? 0) +
      Number(snap?.inbound_shipped ?? 0) +
      Number(snap?.inbound_receiving ?? 0);
    const awdOh = Number(awdItem?.awd_on_hand ?? 0);
    const tplOh = Number(tplItem?.available ?? 0);

    // Two supply pools
    const fbaSupply = fba + inbound + (useAwd ? awdOh : 0);
    const ownedTotal = fba + inbound + awdOh + tplOh;

    const today = new Date();
    const endParts = untilDate.split("-").map(Number);
    const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);
    endDate.setDate(endDate.getDate() + bufferDays);
    const horizonDays = Math.floor((endDate.getTime() - today.getTime()) / 86400000);

    let cursor = new Date(today);
    let remaining = fba; // FBA-only burn
    let totalDemand = 0;
    let stockoutDate: string | null = null;
    const weeks: WeekRow[] = [];

    while (cursor <= endDate) {
      const weekEnd = new Date(cursor);
      weekEnd.setDate(weekEnd.getDate() + 6);
      if (weekEnd > endDate) weekEnd.setTime(endDate.getTime());

      const days =
        Math.floor(
          (weekEnd.getTime() - cursor.getTime()) / 86400000,
        ) + 1;
      const isoWk =
        Math.ceil(
          ((cursor.getTime() -
            new Date(cursor.getFullYear(), 0, 1).getTime()) /
            86400000 +
            new Date(cursor.getFullYear(), 0, 1).getDay() +
            1) /
            7,
        ) || 1;
      const clampedWk = ((isoWk - 1) % 52) + 1;
      const mult = seasonMap.get(clampedWk) ?? 1.0;

      // Use imported forecast if available for this week, else velocity × seasonality
      const forecastUnits = getForecastDemand(cursor.getTime(), weekEnd.getTime());
      const planDaily = planningDaily(vel ?? {});
      const demand = forecastUnits != null
        ? Math.round(forecastUnits * stress)
        : Math.round(Math.max(baseDaily, planDaily) * days * mult * stress);
      totalDemand += demand;
      remaining -= demand;

      let status = "";
      if (remaining <= 0 && !stockoutDate) {
        stockoutDate = localDate(cursor);
        status = "STOCKOUT";
      } else if (remaining <= 0) {
        status = "OUT";
      } else if (remaining < baseDaily * 14) {
        status = "LOW";
      }

      weeks.push({
        week: clampedWk,
        start: localDate(cursor),
        end: localDate(weekEnd),
        mult,
        demand,
        remaining: Math.max(remaining, 0),
        status,
      });

      cursor = new Date(weekEnd);
      cursor.setDate(cursor.getDate() + 1);
    }

    const fbaGap = Math.max(totalDemand - fbaSupply, 0);
    const produceGap = Math.max(totalDemand - ownedTotal, 0);
    const transferFromTpl = Math.min(tplOh, fbaGap);
    const transferFromAwd = !useAwd && awdOh > 0
      ? Math.min(awdOh, Math.max(fbaGap - transferFromTpl, 0))
      : 0;
    const avgDailyHorizon = horizonDays > 0 ? totalDemand / horizonDays : baseDaily;

    return {
      totalDemand,
      fbaSupply,
      ownedTotal,
      fbaGap,
      produceGap,
      stockoutDate,
      stockoutDays: stockoutDate
        ? Math.floor(
            (new Date(stockoutDate).getTime() - Date.now()) / 86400000,
          )
        : null,
      weeks,
      transferFromTpl,
      transferFromAwd,
      produce: produceGap,
      avgDailyHorizon,
      baseDailyV30: baseDaily,
    };
  }, [
    ran,
    selectedSku,
    snapshots,
    velocities,
    seasonality,
    awdList,
    tplList,
    untilDate,
    bufferDays,
    useAwd,
    include3pl,
    stress,
  ]);

  const vel = velocities.find((v) => v.sku === selectedSku);
  const snap = snapshots.find((s) => s.sku === selectedSku);
  const awdItem = awdList.find((a) => a.sku === selectedSku);
  const tplItem = tplList.find((t) => t.sku === selectedSku);

  // Auto-run when SKU comes from URL param
  useEffect(() => {
    if (selectedSku && !autoRan && !loading && velocities.length > 0) {
      setRan(true);
      setAutoRan(true);
    }
  }, [selectedSku, autoRan, loading, velocities.length]);

  if (!isConfigured()) return <SetupPrompt />;
  if (loading) return <LoadingState />;

  // Chart
  const maxDemand = plan
    ? Math.max(...plan.weeks.map((w) => w.demand), 1)
    : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Plan SKU</h1>
          <p className="text-sm text-muted-foreground">
            Forward sell-through projection with seasonality
          </p>
        </div>
        <Link href="/inventory">
          <Button variant="outline" size="sm">
            ← Inventory
          </Button>
        </Link>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                SKU
              </label>
              <select
                value={selectedSku}
                onChange={(e) => {
                  setSelectedSku(e.target.value);
                  setRan(false);
                }}
                className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              >
                <option value="">Select SKU...</option>
                {skuOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Plan through
              </label>
              <input
                type="date"
                value={untilDate}
                onChange={(e) => {
                  setUntilDate(e.target.value);
                  setRan(false);
                }}
                className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Buffer days
              </label>
              <input
                type="number"
                value={bufferDays}
                onChange={(e) => setBufferDays(Number(e.target.value))}
                className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useAwd} onChange={(e) => setUseAwd(e.target.checked)} />
                AWD in FBA supply
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={include3pl} onChange={(e) => setInclude3pl(e.target.checked)} />
                3PL in FBA supply
              </label>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">Stress test:</span>
            {[1.0, 1.25, 1.4].map((s) => (
              <Button
                key={s}
                size="sm"
                variant={stress === s ? "default" : "outline"}
                onClick={() => { setStress(s); setRan(false); }}
              >
                {s === 1.0 ? "Base" : `×${s}`}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
          </div>
          <Button
            onClick={() => setRan(true)}
            disabled={!selectedSku}
            className="w-full sm:w-auto"
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Run Plan
          </Button>
        </CardContent>
      </Card>

      {/* Supply summary (when SKU selected) */}
      {selectedSku && vel && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">
                Velocity
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {Number(vel.total_u_30).toFixed(1)}{" "}
                <span className="text-xs text-muted-foreground">u/day</span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                Amz {Number(vel.amazon_u_30).toFixed(1)} · Shop{" "}
                {Number(vel.shopify_u_30).toFixed(1)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">
                FBA
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {fmt(
                  Number(snap?.fulfillable ?? 0) +
                    Number(snap?.reserved ?? 0) +
                    Number(snap?.researching ?? 0) +
                    Number(snap?.unfulfillable ?? 0),
                )}
              </p>
              <p className="text-[10px] text-muted-foreground">
                +{fmt(
                  Number(snap?.inbound_working ?? 0) +
                    Number(snap?.inbound_shipped ?? 0) +
                    Number(snap?.inbound_receiving ?? 0),
                )}{" "}
                inbound
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">
                AWD
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {fmt(awdItem?.awd_on_hand ?? 0)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase">
                3PL
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {fmt(tplItem?.available ?? 0)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results */}
      {plan && (
        <>
          {/* Summary strip */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Card>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  Demand{stress !== 1.0 ? ` ×${stress}` : ""}
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {fmt(plan.totalDemand)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {plan.avgDailyHorizon.toFixed(0)} u/day avg
                  {plan.avgDailyHorizon > plan.baseDailyV30 * 1.05 &&
                    ` (+${Math.round(((plan.avgDailyHorizon / plan.baseDailyV30) - 1) * 100)}% seasonal)`}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  FBA Supply
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {fmt(plan.fbaSupply)}
                </p>
              </CardContent>
            </Card>
            <Card className={plan.stockoutDate ? "border-red-500/40" : ""}>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  FBA Stockout
                </p>
                <p className={`text-lg font-semibold tabular-nums ${plan.stockoutDate ? "text-red-500" : ""}`}>
                  {plan.stockoutDate ?? "None"}
                </p>
                {plan.stockoutDays !== null && (
                  <p className="text-[10px] text-red-500">{plan.stockoutDays}d</p>
                )}
              </CardContent>
            </Card>
            <Card className={plan.fbaGap > 0 ? "border-amber-500/40" : ""}>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  Transfer to FBA
                </p>
                <p className={`text-lg font-semibold tabular-nums ${plan.fbaGap > 0 ? "text-amber-600" : ""}`}>
                  {plan.fbaGap > 0 ? fmt(plan.transferFromTpl + plan.transferFromAwd) : "—"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  Owned Total
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {fmt(plan.ownedTotal)}
                </p>
              </CardContent>
            </Card>
            <Card className={plan.produce > 0 ? "border-red-500/40" : "border-emerald-500/40"}>
              <CardContent className="p-3">
                <p className="text-[10px] text-muted-foreground uppercase">
                  Produce
                </p>
                <p className={`text-lg font-semibold tabular-nums ${plan.produce > 0 ? "text-red-500" : "text-emerald-500"}`}>
                  {plan.produce > 0 ? fmt(plan.produce) : "0"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Action card */}
          <Card className={plan.fbaGap > 0 ? "border-amber-500/30" : "border-emerald-500/30"}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className={`h-4 w-4 ${plan.fbaGap > 0 ? "text-amber-500" : "text-emerald-500"}`} />
                {plan.produce === 0 && plan.fbaGap > 0
                  ? "Transfer Problem — No Production Needed"
                  : plan.produce > 0
                    ? "Production + Transfer Needed"
                    : "Fully Covered"}
              </div>
              {plan.transferFromTpl > 0 && (
                <p className="text-sm">
                  3PL → FBA: <span className="font-semibold">{fmt(plan.transferFromTpl)}</span> units
                </p>
              )}
              {plan.transferFromAwd > 0 && (
                <p className="text-sm">
                  AWD → FBA: <span className="font-semibold">{fmt(plan.transferFromAwd)}</span> units
                </p>
              )}
              {plan.produce > 0 && (
                <p className="text-sm">
                  Produce: <span className="font-semibold">{fmt(plan.produce)}</span> units
                </p>
              )}
              {plan.produce === 0 && plan.fbaGap > 0 && (
                <p className="text-xs text-muted-foreground">
                  You have enough total inventory. Move stock into FBA before {plan.stockoutDate} to avoid stockout.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Weekly demand chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Weekly Demand Forecast ({plan.weeks.length} weeks)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {plan.weeks.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No weekly forecast — run Plan with a SKU and target date.
                </p>
              ) : (<>
              <div className="flex gap-px" style={{ height: "160px" }}>
                {plan.weeks.map((w, i) => {
                  const barH = maxDemand > 0 ? (w.demand / maxDemand) * 160 : 0;
                  const isQ4 = w.week >= 40 && w.week <= 52;
                  const isOut = w.status === "STOCKOUT" || w.status === "OUT";
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col justify-end min-w-0"
                      title={`W${w.week} ${w.start}\n${fmt(w.demand)} units (${w.mult.toFixed(2)}x)\nFBA: ${fmt(w.remaining)}${w.status ? ` — ${w.status}` : ""}`}
                    >
                      <div
                        className={`w-full rounded-t-sm ${
                          isOut
                            ? "bg-red-400"
                            : isQ4
                              ? "bg-amber-500"
                              : "bg-blue-400"
                        }`}
                        style={{ height: `${barH}px` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>
                  W{plan.weeks[0]?.week} ({plan.weeks[0]?.start.slice(5)})
                </span>
                <span className="flex gap-3">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-blue-400" />{" "}
                    Normal
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />{" "}
                    Q4
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-red-400" />{" "}
                    Stockout
                  </span>
                </span>
                <span>
                  W{plan.weeks[plan.weeks.length - 1]?.week}
                </span>
              </div>
              </>)}
            </CardContent>
          </Card>

          {/* Weekly table */}
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Week</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead className="text-right">Mult</TableHead>
                    <TableHead className="text-right">Demand</TableHead>
                    <TableHead className="text-right">FBA Rem</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.weeks.map((w, i) => (
                    <TableRow
                      key={i}
                      className={
                        w.status === "STOCKOUT" || w.status === "OUT"
                          ? "bg-red-50 dark:bg-red-950/30"
                          : w.status === "LOW"
                            ? "bg-amber-50 dark:bg-amber-950/30"
                            : i % 2 === 1
                              ? "bg-muted/20"
                              : ""
                      }
                    >
                      <TableCell className="font-medium">W{w.week}</TableCell>
                      <TableCell className="text-xs">
                        {w.start} → {w.end}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.mult.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {fmt(w.demand)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(w.remaining)}
                      </TableCell>
                      <TableCell>
                        {w.status && (
                          <span
                            className={`text-xs font-medium ${
                              w.status === "STOCKOUT" || w.status === "OUT"
                                ? "text-red-600"
                                : "text-amber-600"
                            }`}
                          >
                            {w.status}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Demand = calibrated 30d velocity × weekly seasonality. FBA stockout =
        when FBA on-hand is exhausted at seasonal rate. Not financial advice.
      </p>
    </div>
  );
}
