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
import type { FourNumbersPlan } from "@/lib/inventory-four-numbers";
import { DEFAULT_RECEIVING_DAYS, DEFAULT_UNTIL_DATE } from "@/lib/inventory-supply-shared";
import { useFourNumbersPlan } from "@/lib/use-four-numbers-plan";
import { formatManufactureAction } from "@/lib/inventory-supply-display";
import { Calculator, AlertTriangle, Download } from "lucide-react";
import { displayTitle } from "@/lib/display-title";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Supply tab — per-SKU four numbers (summary cards live on Planning hub). */
export function InboundPlannerView({ plan: planProp }: { plan?: FourNumbersPlan | null }) {
  const [untilDate, setUntilDate] = useState(DEFAULT_UNTIL_DATE);
  const [receivingDays, setReceivingDays] = useState(String(DEFAULT_RECEIVING_DAYS));
  const { plan: hookPlan, loading, error } = useFourNumbersPlan({
    untilDate,
    receivingDays: Number(receivingDays) || DEFAULT_RECEIVING_DAYS,
  });
  const plan = planProp ?? hookPlan;

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
      <div className="py-12 text-center text-sm text-muted-foreground">
        Connect Supabase to load supply plan.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Per-SKU detail for the four supply numbers shown above. Phased demand — not peak holiday rate in August.
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
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && <LoadingState />}

      {!loading && plan && (
        <>
          {plan.wavesConsolidated.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Warehouse ship schedule (3PL → FBA)</CardTitle>
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

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Per-SKU — four numbers</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Mfg</TableHead>
                    <TableHead>Order by</TableHead>
                    <TableHead className="text-right">→FBA next</TableHead>
                    <TableHead className="text-right">FBA DOS</TableHead>
                    <TableHead>FBA out</TableHead>
                    <TableHead>Net OOS</TableHead>
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
                          {formatManufactureAction(
                            r.manufactureQty,
                            r.orderBy,
                            r.orderUrgent,
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.shipToFba > 0 ? fmt(r.shipToFba) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.fbaDosPhased != null ? `${r.fbaDosPhased}d` : "—"}
                        </TableCell>
                        <TableCell className="text-xs">{r.fbaStockoutDate ?? "—"}</TableCell>
                        <TableCell className="text-xs font-medium">{r.networkOosDate ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <Calculator className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Same calculations as Inventory and Pallet Planner via{" "}
              <code className="text-[10px]">inventory-four-numbers</code>. Planning aid — not a PO.
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
