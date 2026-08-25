"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { useInventorySkus } from "@/lib/use-inventory-skus";
import { buildFourNumbersPlan } from "@/lib/inventory-four-numbers";
import type { ForecastWeekRow } from "@/lib/inventory-phased-demand";
import type { SeasonalityWeekly } from "@/lib/types";
import {
  Shield, Calculator, AlertTriangle, Download, Factory, Truck, Clock, Package,
} from "lucide-react";
import { displayTitle } from "@/lib/display-title";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Inbound / supply tab — four planning numbers. */
export function InboundPlannerView() {
  const skuList = useInventorySkus();
  const [untilDate, setUntilDate] = useState("2027-01-15");
  const [receivingDays, setReceivingDays] = useState("18");
  const [loading, setLoading] = useState(true);
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch("/api/inventory")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setRaw(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const plan = useMemo(() => {
    if (!raw || skuList.length === 0) return null;
    const snapshots = (raw.snapshots ?? []) as Array<Record<string, unknown>>;
    const velocities = (raw.velocity ?? []) as Array<Record<string, unknown>>;
    const tpl = (raw.tpl ?? []) as Array<{ sku: string; available: number }>;
    const awd = (raw.awd ?? []) as Array<{ sku: string; awd_on_hand: number }>;
    const seasonality = (raw.seasonality ?? []) as SeasonalityWeekly[];
    const forecast = (raw.forecast ?? []) as ForecastWeekRow[];

    const activeSkus = skuList.filter((s) => s !== "UNKNOW" && s !== "UNKNOWN");

    return buildFourNumbersPlan({
      skus: activeSkus,
      snapshots: snapshots.map((s) => ({
        sku: String(s.sku),
        fulfillable: Number(s.fulfillable ?? 0),
        reserved: Number(s.reserved ?? 0),
        researching: Number(s.researching ?? 0),
        unfulfillable: Number(s.unfulfillable ?? 0),
        inbound_working: Number(s.inbound_working ?? 0),
        inbound_shipped: Number(s.inbound_shipped ?? 0),
        inbound_receiving: Number(s.inbound_receiving ?? 0),
      })),
      velocities: velocities.map((v) => ({
        sku: String(v.sku),
        product_name: String(v.product_name ?? ""),
        total_u_30: Number(v.total_u_30 ?? 0),
        planning_u_30: Number(v.planning_u_30 ?? 0),
        holiday_prior_daily: Number(v.holiday_prior_daily ?? 0),
        yoy_growth_mult: Number(v.yoy_growth_mult ?? 1),
        holiday_surge_mult: Number(v.holiday_surge_mult ?? 1),
      })),
      tpl,
      awd,
      seasonality,
      forecast,
      untilDate,
      receivingDays: Number(receivingDays) || 18,
    });
  }, [raw, skuList, untilDate, receivingDays]);

  function exportCsv() {
    if (!plan) return;
    const header =
      "SKU,Product,Line,Manufacture,Order_By,Ship_FBA,Ship_AWD,FBA_DOS_Phased,FBA_Stockout,Network_OOS,Network_Supply\n";
    const rows = plan.skuRows
      .map((r) =>
        `"${r.sku}","${r.productName}",${r.productLine},${r.manufactureQty},${r.orderBy ?? ""},${r.shipToFba},${r.shipToAwd},${r.fbaDosPhased ?? ""},${r.fbaStockoutDate ?? ""},${r.networkOosDate ?? ""},${r.networkSupply}`,
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `supply_plan_${plan.generated}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!isConfigured()) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Four supply numbers at phased (seasonal) demand — not peak holiday rate in August.
        Lip balm manufacture lead 6w · balm/deodorant 8–10w · warehouse→Prime ~2–3w.
      </p>

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="text-xs font-medium">Plan through</label>
              <Input
                type="date"
                value={untilDate}
                onChange={(e) => setUntilDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Warehouse→Prime days</label>
              <Input
                type="number"
                min={14}
                max={28}
                value={receivingDays}
                onChange={(e) => setReceivingDays(e.target.value)}
                className="mt-1"
              />
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={exportCsv} disabled={!plan}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && <LoadingState />}

      {!loading && plan && (
        <>
          {/* Four numbers — portfolio */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-primary/30">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
                  <Factory className="h-3.5 w-3.5" />
                  1 · Manufacture order
                </div>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {fmt(plan.totalManufacture)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Lip 6w · balm/deo 10w lead
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
                  <Truck className="h-3.5 w-3.5" />
                  2 · Warehouse ship
                </div>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {fmt(plan.totalWarehouseShipFba)}
                  <span className="text-sm font-normal text-muted-foreground"> → FBA</span>
                </p>
                {plan.totalWarehouseShipAwd > 0 && (
                  <p className="text-xs text-muted-foreground">
                    + {fmt(plan.totalWarehouseShipAwd)} → AWD staging
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  3 · FBA DOS (no new sends)
                </div>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {plan.skuRows.filter((r) => r.fbaDosPhased != null).length > 0
                    ? `${Math.round(
                        plan.skuRows.reduce((s, r) => s + (r.fbaDosPhased ?? 0), 0) /
                          plan.skuRows.filter((r) => r.fbaDosPhased).length,
                      )}d avg`
                    : "—"}
                </p>
                <p className="text-xs text-muted-foreground">Phased demand rate</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
                  <Package className="h-3.5 w-3.5" />
                  4 · Network OOS
                </div>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {(() => {
                    const dates = plan.skuRows
                      .map((r) => r.networkOosDate)
                      .filter(Boolean) as string[];
                    if (!dates.length) return "—";
                    return dates.sort()[0];
                  })()}
                </p>
                <p className="text-xs text-muted-foreground">Earliest FBA+AWD+3PL out</p>
              </CardContent>
            </Card>
          </div>

          {/* Ship schedule */}
          {plan.wavesConsolidated.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Warehouse ship schedule (3PL → FBA)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ship by</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                      <TableHead>Mix</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.wavesConsolidated.map((w) => (
                      <TableRow
                        key={w.ship_by}
                        className={w.urgent ? "bg-red-50 dark:bg-red-950/30" : ""}
                      >
                        <TableCell className="font-medium">
                          {w.ship_by}
                          {w.urgent && (
                            <Badge variant="outline" className="ml-2 text-[9px] text-red-600">
                              URGENT
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">
                          {fmt(w.total_units)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {Object.entries(w.mix)
                            .map(([sku, q]) => `${sku.slice(0, 12)} ${fmt(q)}`)
                            .join(" · ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Per-SKU four numbers */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Per-SKU — four numbers</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right" title="Order from manufacturer">
                      Mfg
                    </TableHead>
                    <TableHead>Order by</TableHead>
                    <TableHead className="text-right" title="Ship 3PL → FBA">
                      →FBA
                    </TableHead>
                    <TableHead className="text-right" title="FBA days of supply at phased rate">
                      FBA DOS
                    </TableHead>
                    <TableHead title="FBA stockout if no new sends">
                      FBA out
                    </TableHead>
                    <TableHead title="Network OOS (FBA+inb+AWD+3PL)">
                      Net OOS
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.skuRows
                    .filter(
                      (r) =>
                        r.manufactureQty > 0 ||
                        r.shipToFba > 0 ||
                        r.fbaDosPhased != null ||
                        r.networkOosDate,
                    )
                    .map((r) => (
                      <TableRow key={r.sku}>
                        <TableCell>
                          <div className="font-medium text-sm">
                            {displayTitle(r.productName).slice(0, 32)}
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            {r.sku} · {r.productLine} ({r.productionLeadDays}d)
                          </span>
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums font-semibold ${r.manufactureQty > 0 ? "text-primary" : ""}`}
                        >
                          {r.manufactureQty > 0 ? fmt(r.manufactureQty) : "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.orderBy ? (
                            <span className={r.orderUrgent ? "text-red-600 font-medium" : ""}>
                              {r.orderBy}
                              {r.orderUrgent && " !"}
                            </span>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.shipToFba > 0 ? fmt(r.shipToFba) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.fbaDosPhased != null ? `${r.fbaDosPhased}d` : "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.fbaStockoutDate ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {r.networkOosDate ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <Calculator className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>1 Manufacture</strong> = holiday need (Nov–Jan YoY) minus all owned stock.
              <strong> 2 Ship</strong> = phased 60d FBA cover waves from 3PL ({plan.receivingDays}d lead).
              <strong> 3 FBA DOS</strong> = FBA ÷ phased daily (no new warehouse sends; inbound pipeline counts).
              <strong> 4 Network OOS</strong> = when FBA+inbound+AWD+3PL exhaust at phased rate.
              Planning aid — not a PO.
            </span>
          </div>
        </>
      )}

      {!loading && !plan && !error && (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No inventory SKUs loaded yet.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
