"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, Package, RotateCcw, AlertTriangle } from "lucide-react";
import Link from "next/link";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

interface ReturnRow {
  return_date: string; order_id: string; sku: string; asin: string | null;
  product_name: string | null; quantity: number; fulfillment_center: string | null;
  disposition: string | null; reason: string | null; status: string | null;
  customer_comments: string | null;
}

export default function ReturnsPage() {
  const [data, setData] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/fba-returns").then((r) => r.json()).then((d) => {
      setData(d.returns ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const now = new Date();

  const { total7d, total30d, byReason, bySku, trend7, trend30 } = useMemo(() => {
    const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d7iso = d7.toISOString();
    const d30iso = d30.toISOString();

    const r7 = data.filter((r) => r.return_date >= d7iso);
    const r30 = data.filter((r) => r.return_date >= d30iso);

    const t7 = r7.reduce((s, r) => s + r.quantity, 0);
    const t30 = r30.reduce((s, r) => s + r.quantity, 0);

    // By reason (30d)
    const reasons: Record<string, number> = {};
    for (const r of r30) {
      const key = r.reason || "Unknown";
      reasons[key] = (reasons[key] ?? 0) + r.quantity;
    }

    // By SKU (30d)
    const skus: Record<string, { name: string; qty: number; returns: number }> = {};
    for (const r of r30) {
      if (!skus[r.sku]) skus[r.sku] = { name: r.product_name?.split(" - ")[0]?.split("Tallowbourn ")[1] || r.sku, qty: 0, returns: 0 };
      skus[r.sku].qty += r.quantity;
      skus[r.sku].returns++;
    }

    // Prior 7d for trend
    const d14 = new Date(now); d14.setDate(d14.getDate() - 14);
    const r7prev = data.filter((r) => r.return_date >= d14.toISOString() && r.return_date < d7iso);
    const t7prev = r7prev.reduce((s, r) => s + r.quantity, 0);

    const d60 = new Date(now); d60.setDate(d60.getDate() - 60);
    const r30prev = data.filter((r) => r.return_date >= d60.toISOString() && r.return_date < d30iso);
    const t30prev = r30prev.reduce((s, r) => s + r.quantity, 0);

    return {
      total7d: t7, total30d: t30,
      byReason: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
      bySku: Object.entries(skus).sort((a, b) => b[1].qty - a[1].qty),
      trend7: t7prev > 0 ? Math.round(((t7 / t7prev) - 1) * 100) : null,
      trend30: t30prev > 0 ? Math.round(((t30 / t30prev) - 1) * 100) : null,
    };
  }, [data]);

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">FBA Returns</h1>
          <p className="text-sm text-muted-foreground">Customer return rate by SKU and reason</p>
        </div>
        <Link href="/inventory"><Button variant="outline" size="sm">← Inventory</Button></Link>
      </div>

      {!data.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <RotateCcw className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No return data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run: <code>python -m src.main spapi-returns --days 90</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Last 7 Days</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(total7d)}</p>
                {trend7 !== null && (
                  <p className={`text-xs font-medium ${trend7 > 0 ? "text-red-500" : "text-emerald-500"}`}>
                    {trend7 >= 0 ? "+" : ""}{trend7}% vs prior 7d
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Last 30 Days</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(total30d)}</p>
                {trend30 !== null && (
                  <p className={`text-xs font-medium ${trend30 > 0 ? "text-red-500" : "text-emerald-500"}`}>
                    {trend30 >= 0 ? "+" : ""}{trend30}% vs prior 30d
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">SKUs Affected</p>
                <p className="text-2xl font-semibold tabular-nums">{bySku.length}</p>
                <p className="text-xs text-muted-foreground">last 30d</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Top Reason</p>
                <p className="text-lg font-semibold">{byReason[0]?.[0]?.replace(/_/g, " ") ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{byReason[0]?.[1] ?? 0} units</p>
              </CardContent>
            </Card>
          </div>

          {/* By SKU */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Returns by SKU (30d)</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Returns</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bySku.map(([sku, info]) => (
                    <TableRow key={sku}>
                      <TableCell className="font-medium text-xs">{sku}</TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">{info.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(info.qty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(info.returns)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* By Reason */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Returns by Reason (30d)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {byReason.map(([reason, count]) => {
                  const pct = total30d > 0 ? (count / total30d) * 100 : 0;
                  return (
                    <div key={reason} className="flex items-center gap-3">
                      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className="text-xs w-32 truncate">{reason.replace(/_/g, " ")}</span>
                      <span className="text-xs tabular-nums font-medium w-10 text-right">{fmt(count)}</span>
                      <span className="text-[10px] text-muted-foreground w-10 text-right">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Recent returns */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Recent Returns</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Disposition</TableHead>
                    <TableHead>FC</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.slice(0, 25).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs tabular-nums">{r.return_date.slice(0, 10)}</TableCell>
                      <TableCell className="text-xs font-medium">{r.sku}</TableCell>
                      <TableCell className="text-xs">{r.reason?.replace(/_/g, " ") ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${
                          r.disposition === "SELLABLE" ? "bg-emerald-50 text-emerald-700" :
                          r.disposition === "DEFECTIVE" ? "bg-red-50 text-red-700" :
                          ""
                        }`}>
                          {r.disposition || "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.fulfillment_center || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
