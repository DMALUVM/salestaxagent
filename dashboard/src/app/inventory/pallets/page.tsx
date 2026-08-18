"use client";

import { useMemo, useState } from "react";
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
import { Shield, Package } from "lucide-react";
import Link from "next/link";

const SKUS = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"];
const SKU_LABELS: Record<string, string> = {
  DDPE0001Shop: "Unscented 3pk",
  DDPE0002Shop: "Peppermint 3pk",
  DDPE0003Shop: "Sweet Orange 3pk",
  DDPE0004Shop: "Assorted 3pk",
};
const PALLET_MAX = 19_000;
const TARGET = "2026-10-31";

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

interface SkuPlan {
  sku: string;
  label: string;
  novDecDemand: number;
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  supply: number;
  gap: number;
}

interface Pallet {
  num: number;
  mix: Record<string, number>;
  total: number;
}

export default function PalletPlanPage() {
  if (!isConfigured()) return <SetupPrompt />;

  const { data: raw, loading } = useInventory();
  const [include3pl, setInclude3pl] = useState(true);
  const [includeAwd, setIncludeAwd] = useState(true);

  const snapshots = (raw?.snapshots ?? []) as InventorySnapshot[];
  const forecasts = (raw?.forecast ?? []) as { sku: string; week_start: string; scenario: string; units: number }[];
  const awdList = (raw?.awd ?? []) as { sku: string; awd_on_hand: number }[];
  const tplList = (raw?.tpl ?? []) as { sku: string; available: number }[];

  const { skuPlans, pallets, totalGap, totalDemand, totalSupply } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(tplList.map((t) => [t.sku, t]));

    const plans: SkuPlan[] = [];
    let tGap = 0;
    let tDemand = 0;
    let tSupply = 0;

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
        if (m === "2026-11" || m === "2026-12") {
          novDecDemand += Number(f.units);
        }
      }
      novDecDemand = Math.round(novDecDemand);

      const gap = Math.max(novDecDemand - supply, 0);
      tGap += gap;
      tDemand += novDecDemand;
      tSupply += supply;

      plans.push({
        sku, label: SKU_LABELS[sku] ?? sku,
        novDecDemand, fba, inbound, awd, tpl, supply, gap,
      });
    }

    // Build pallets
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

  if (loading) return <LoadingState />;

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

      {/* Summary cards */}
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
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Pallets Needed</p>
            <p className="text-2xl font-semibold tabular-nums">{pallets.length}</p>
            <p className="text-xs text-muted-foreground">@ {fmt(PALLET_MAX)} units each</p>
          </CardContent>
        </Card>
      </div>

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

      <p className="text-xs text-muted-foreground">
        Demand from forecast_weekly (correction_factor scenario). {include3pl ? "3PL transfer to FBA assumed complete by target date." : "3PL excluded."} Planning aid — not a purchase order.
      </p>
    </div>
  );
}
