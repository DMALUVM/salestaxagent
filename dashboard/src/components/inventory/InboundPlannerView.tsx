"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, Calculator, AlertTriangle, Download } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

const PALLET_MAX = 19_000;

interface SkuPlan {
  sku: string;
  productName: string;
  asin: string;
  // Forecast
  expected: number;
  coverage: number;
  lowBand: number;
  highBand: number;
  methodA: number;
  methodB: number;
  methodC: number;
  spreadPct: number;
  spreadWarning: boolean;
  modelVersion: string;
  weights: { a: number; b: number; c: number };
  // Inventory
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  totalOnHand: number;
  // Computed
  shipQty: number;
  pallets: number;
  orderBy: string | null;
  // Data
  numWeeks: number;
  snsActive: number;
  snsShipped: number;
  velocity: number;
}

interface InvRow {
  sku: string;
  fulfillable?: number; reserved?: number; researching?: number; unfulfillable?: number;
  inbound_working?: number; inbound_shipped?: number; inbound_receiving?: number;
}

/** Inbound tab of /planning. Was app/planner/page.tsx — logic unchanged. */
export function InboundPlannerView() {
  const [skuInput, setSkuInput] = useState("DDPE0001Shop,DDPE0002Shop,DDPE0003Shop,DDPE0004Shop");
  const [endDate, setEndDate] = useState("2027-03-31");
  const [safety, setSafety] = useState("15");
  const [leadDays, setLeadDays] = useState("30");
  const [loading, setLoading] = useState(false);
  const [plans, setPlans] = useState<SkuPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  // NOTE: this view previously loaded the inventory SKU list into state and
  // never rendered it — it takes SKUs from the free-text field below. The
  // loader now lives in @/lib/use-inventory-skus and is used by the Demand
  // view; this view no longer makes that unused request.

  async function runPlanner() {
    setLoading(true); setError(null); setPlans([]);
    const skus = skuInput.split(",").map((s) => s.trim()).filter(Boolean);
    if (!skus.length) { setError("Enter at least one SKU"); setLoading(false); return; }

    try {
      // Fetch inventory
      const invResp = await fetch("/api/inventory");
      const invData = await invResp.json();
      const snapshots: InvRow[] = invData.snapshots ?? [];
      const awdRows: Array<{ sku: string; awd_on_hand: number }> = invData.awd ?? [];
      const tplRows: Array<{ sku: string; available: number }> = invData.tpl ?? [];

      const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
      const awdMap = new Map(awdRows.map((a) => [a.sku, a]));
      const tplMap = new Map(tplRows.map((t) => [t.sku, t]));

      const safetyPct = Number(safety) / 100;
      const lead = Number(leadDays) || 0;

      const results: SkuPlan[] = [];

      for (const sku of skus) {
        const params = new URLSearchParams({ sku, end: endDate, safety: String(safetyPct) });
        const fcResp = await fetch(`/api/forecast-sku?${params}`);
        const fc = await fcResp.json();

        if (fc.error) {
          setError(`${sku}: ${fc.error}`);
          continue;
        }

        // Inventory
        const snap = snapMap.get(sku);
        const fba = (Number(snap?.fulfillable ?? 0) + Number(snap?.reserved ?? 0)
          + Number(snap?.researching ?? 0) + Number(snap?.unfulfillable ?? 0));
        const inbound = (Number(snap?.inbound_working ?? 0) + Number(snap?.inbound_shipped ?? 0)
          + Number(snap?.inbound_receiving ?? 0));
        const awd = Number(awdMap.get(sku)?.awd_on_hand ?? 0);
        const tpl = Number(tplMap.get(sku)?.available ?? 0);
        const totalOnHand = fba + inbound + awd + tpl;

        const shipQty = Math.max(0, fc.coverage_units - totalOnHand);
        const pallets = Math.ceil(shipQty / PALLET_MAX);

        // Order-by date
        let orderBy: string | null = null;
        if (lead > 0) {
          const d = new Date(endDate + "T00:00:00");
          d.setDate(d.getDate() - lead);
          orderBy = d.toISOString().slice(0, 10);
        }

        results.push({
          sku,
          productName: fc.product_name || sku,
          asin: fc.asin || "",
          expected: fc.expected_units,
          coverage: fc.coverage_units,
          lowBand: fc.low_band,
          highBand: fc.high_band,
          methodA: fc.methods.A_naive_runrate,
          methodB: fc.methods.B_seasonal_yoy,
          methodC: fc.methods.C_sns_plus_organic,
          spreadPct: fc.methods.spread_pct,
          spreadWarning: fc.methods.spread_warning,
          modelVersion: fc.model_version,
          weights: fc.weights,
          fba, inbound, awd, tpl, totalOnHand,
          shipQty, pallets, orderBy,
          numWeeks: fc.num_weeks,
          snsActive: fc.breakdown.sns_active_subs,
          snsShipped: fc.breakdown.sns_weekly_shipped,
          velocity: fc.breakdown.blended_daily_velocity,
        });
      }

      setPlans(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }

  function exportCsv() {
    if (!plans.length) return;
    const header = "SKU,Product,Expected,Coverage,On_Hand,Ship_Qty,Pallets,Order_By,Model,Spread%,SnS_Subs,Velocity\n";
    const rows = plans.map((p) =>
      `"${p.sku}","${p.productName}",${p.expected},${p.coverage},${p.totalOnHand},${p.shipQty},${p.pallets},${p.orderBy || ""},${p.modelVersion},${p.spreadPct},${p.snsActive},${p.velocity}`
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pallet_plan_${endDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );

  const totalShip = plans.reduce((s, p) => s + p.shipQty, 0);
  const totalPallets = Math.ceil(totalShip / PALLET_MAX);

  return (
    <div className="space-y-6">
      {/* The hub's <h1> and the active tab already name this view; the
          descriptive line is kept verbatim. */}
      <p className="text-sm text-muted-foreground">
        Forecast-driven production/ship plan using calibrated demand model
      </p>

      {/* Inputs */}
      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-5">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium">SKUs (comma-separated)</label>
              <Input value={skuInput} onChange={(e) => setSkuInput(e.target.value)} className="mt-1"
                placeholder="DDPE0001Shop,DDPE0002Shop,..." />
            </div>
            <div>
              <label className="text-xs font-medium">Cover Through</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium">Safety %</label>
                <Input type="number" min="0" max="50" value={safety} onChange={(e) => setSafety(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium">Lead Days</label>
                <Input type="number" min="0" value={leadDays} onChange={(e) => setLeadDays(e.target.value)} className="mt-1" />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={runPlanner} disabled={loading} className="flex-1">
                <Calculator className="mr-1.5 h-3.5 w-3.5" />
                {loading ? "Planning..." : "Plan"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && <LoadingState />}

      {plans.length > 0 && (
        <>
          {/* Summary */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card className="border-primary/30">
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Total Ship Qty</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(totalShip)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Pallets</p>
                <p className="text-2xl font-semibold tabular-nums">{totalPallets}</p>
                <p className="text-xs text-muted-foreground">@ {fmt(PALLET_MAX)}/pallet</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">SKUs</p>
                <p className="text-2xl font-semibold tabular-nums">{plans.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Cover Through</p>
                <p className="text-lg font-semibold">{endDate}</p>
                <p className="text-xs text-muted-foreground">{plans[0]?.numWeeks} weeks</p>
              </CardContent>
            </Card>
          </div>

          {/* Per-SKU table */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Per-SKU Plan</CardTitle>
                <Button variant="outline" size="sm" onClick={exportCsv}>
                  <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Coverage</TableHead>
                    <TableHead className="text-right" title="FBA + Inbound + AWD + 3PL">On-Hand</TableHead>
                    <TableHead className="text-right font-semibold" title="max(0, coverage - on_hand)">Ship Qty</TableHead>
                    <TableHead className="text-right">Pallets</TableHead>
                    <TableHead>Order By</TableHead>
                    <TableHead>Model</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.sku}>
                      <TableCell>
                        <div className="font-medium text-sm">{p.productName.split(" - ")[0].replace("Tallowbourn ", "").slice(0, 35)}</div>
                        <span className="text-[10px] text-muted-foreground">{p.sku}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(p.expected)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(p.coverage)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground" title={`FBA ${fmt(p.fba)} + Inb ${fmt(p.inbound)} + AWD ${fmt(p.awd)} + 3PL ${fmt(p.tpl)}`}>
                        {fmt(p.totalOnHand)}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${p.shipQty > 0 ? "text-primary" : "text-emerald-600"}`}>
                        {p.shipQty > 0 ? fmt(p.shipQty) : "Covered"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.pallets > 0 ? p.pallets : "—"}</TableCell>
                      <TableCell className="text-xs">{p.orderBy || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[9px] ${p.modelVersion !== "default" ? "bg-emerald-50 text-emerald-700" : ""}`}
                          title={p.modelVersion === "default" ? "Using global defaults — run forecast-backfill + reconcile for per-SKU weights" : `Per-SKU calibrated: ${p.modelVersion}`}>
                          {p.modelVersion === "default" ? "global" : p.modelVersion}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold bg-muted/30">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(plans.reduce((s, p) => s + p.expected, 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(plans.reduce((s, p) => s + p.coverage, 0))}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(plans.reduce((s, p) => s + p.totalOnHand, 0))}</TableCell>
                    <TableCell className="text-right tabular-nums text-primary">{fmt(totalShip)}</TableCell>
                    <TableCell className="text-right tabular-nums">{totalPallets}</TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Per-SKU detail cards */}
          <div className="grid gap-4 lg:grid-cols-2">
            {plans.filter((p) => p.shipQty > 0).map((p) => (
              <Card key={p.sku} className={p.spreadWarning ? "border-amber-500/30" : ""}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    {p.spreadWarning && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                    {p.productName.split(" - ")[0].replace("Tallowbourn ", "").slice(0, 40)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">A) Naive</p>
                      <p className="tabular-nums">{fmt(p.methodA)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">B) Seasonal</p>
                      <p className="tabular-nums">{fmt(p.methodB)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">C) SnS+Org</p>
                      <p className="tabular-nums">{fmt(p.methodC)}</p>
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span>Vel: {p.velocity} u/d</span>
                    <span>SnS: {fmt(p.snsActive)} subs</span>
                    <span>Weights: {(p.weights.a*100).toFixed(0)}/{(p.weights.b*100).toFixed(0)}/{(p.weights.c*100).toFixed(0)}</span>
                    {p.spreadWarning && <span className="text-amber-500">Spread {p.spreadPct}%</span>}
                  </div>
                  <div className="flex gap-3 text-xs">
                    <span>FBA {fmt(p.fba)}</span>
                    {p.inbound > 0 && <span>Inbound {fmt(p.inbound)}</span>}
                    {p.awd > 0 && <span>AWD {fmt(p.awd)}</span>}
                    {p.tpl > 0 && <span>3PL {fmt(p.tpl)}</span>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              Ship Qty = max(0, coverage - on_hand). On-hand sourced from inventory_snapshots (FBA + inbound)
              + inventory_awd + inventory_3pl_snapshots. Forecast uses calibrated model weights from forecast_model_state.
              Planning aid — not a purchase order.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
