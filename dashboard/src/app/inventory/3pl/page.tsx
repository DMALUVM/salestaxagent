"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, Upload, TrendingUp, TrendingDown, AlertTriangle, Package } from "lucide-react";
import Link from "next/link";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function fmtI(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function pct(n: number) { return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`; }

interface MonthRow {
  month: string; shipping: number; pick: number; order_fee: number;
  packaging: number; storage_shelf: number; storage_bin_med: number;
  storage_pallet: number; storage_bin_sm: number;
  account_mgmt: number; adhoc: number; total: number;
}
interface FeeRow { month: string; section: string; fee_name: string; qty: number; amount: number; }
interface DetailRow { month: string; category: string; amount: number; }

const CATS = [
  { key: "shipping", label: "Shipping", color: "bg-blue-500" },
  { key: "pick_pack", label: "Pick & Pack", color: "bg-emerald-500" },
  { key: "packaging", label: "Packaging", color: "bg-amber-500" },
  { key: "storage", label: "Storage", color: "bg-violet-500" },
  { key: "account_mgmt", label: "Acct Mgmt", color: "bg-slate-400" },
  { key: "adhoc", label: "Ad-hoc", color: "bg-rose-500" },
] as const;

function catBreakdown(m: MonthRow) {
  return {
    shipping: m.shipping,
    pick_pack: m.pick + m.order_fee,
    packaging: m.packaging,
    storage: m.storage_shelf + m.storage_bin_med + m.storage_pallet + m.storage_bin_sm,
    account_mgmt: m.account_mgmt,
    adhoc: m.adhoc,
  };
}

export default function TplCostsPage() {
  const [data, setData] = useState<{ monthly: MonthRow[]; fees: FeeRow[]; detail: DetailRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterMonth, setFilterMonth] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/3pl-costs").then((r) => r.json()).then((d) => {
      setData(d);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(null);
    try {
      const text = await file.text();
      const resp = await fetch("/api/3pl-costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content: text }),
      });
      const result = await resp.json();
      if (resp.ok && result.success) {
        setUploadMsg(`Imported ${file.name}: ${result.months?.join(", ")} — ${result.monthly_count} months, ${result.fee_count} fees, ${result.detail_count} detail rows`);
        // Refresh data
        const fresh = await fetch("/api/3pl-costs").then((r) => r.json());
        setData(fresh);
      } else {
        setUploadMsg(result.error || "Upload failed — unknown error");
      }
    } catch (err) {
      setUploadMsg(`Upload error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setUploading(false);
    e.target.value = "";
  }

  const monthly = useMemo(() => (data?.monthly ?? []).sort((a, b) => a.month.localeCompare(b.month)), [data]);
  const fees = data?.fees ?? [];

  // Summary computations
  const { mtd, lastFull, priorFull, insights, orderStats } = useMemo(() => {
    if (!monthly.length) return { mtd: null, lastFull: null, priorFull: null, insights: [], orderStats: [] };
    const sorted = [...monthly].sort((a, b) => b.month.localeCompare(a.month));
    const mtdRow = sorted[0];
    const lastFullRow = sorted.length > 1 ? sorted[1] : null;
    const priorFullRow = sorted.length > 2 ? sorted[2] : null;

    // Insights
    const ins: { type: "warn" | "info"; text: string }[] = [];

    // MoM change
    if (lastFullRow && priorFullRow && priorFullRow.total > 0) {
      const change = ((lastFullRow.total / priorFullRow.total) - 1) * 100;
      if (Math.abs(change) > 15) {
        ins.push({ type: "warn", text: `${lastFullRow.month} total ${pct(change)} vs ${priorFullRow.month}` });
      }
    }

    // Ad-hoc spike vs 3-month avg
    if (sorted.length >= 4) {
      const recent = sorted[1]?.adhoc ?? 0;
      const avg3 = (sorted.slice(2, 5).reduce((s, r) => s + r.adhoc, 0)) / Math.min(3, sorted.length - 2);
      if (avg3 > 0 && recent > avg3 * 1.5) {
        ins.push({ type: "warn", text: `Ad-hoc ${sorted[1]?.month}: $${fmt(recent)} vs 3-mo avg $${fmt(avg3)}` });
      }
    }

    // Storage trend up while shipping flat
    if (sorted.length >= 3) {
      const s1 = catBreakdown(sorted[1]).storage;
      const s2 = catBreakdown(sorted[2]).storage;
      const sh1 = sorted[1].shipping;
      const sh2 = sorted[2].shipping;
      if (s2 > 0 && s1 > s2 * 1.2 && sh1 <= sh2 * 1.1) {
        ins.push({ type: "warn", text: `Storage rising (${sorted[1].month} $${fmt(s1)} vs $${fmt(s2)}) while shipping flat` });
      }
    }

    // Credits/voids
    const creditFees = fees.filter((f) => f.section === "adhoc" && f.amount < 0);
    const totalCredits = creditFees.reduce((s, f) => s + f.amount, 0);
    if (totalCredits < -10) {
      ins.push({ type: "info", text: `Credits/voids: $${fmt(totalCredits)} across ${creditFees.length} entries` });
    }

    // Cost per order: estimate from order_fee column
    const os = sorted.filter((r) => r.order_fee > 0).map((r) => {
      const orders = Math.round(r.order_fee / 2); // $2 per order
      return {
        month: r.month,
        orders,
        total_per_order: orders > 0 ? r.total / orders : 0,
        shipping_per_order: orders > 0 ? r.shipping / orders : 0,
      };
    });

    return { mtd: mtdRow, lastFull: lastFullRow, priorFull: priorFullRow, insights: ins, orderStats: os };
  }, [monthly, fees]);

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const chartMax = Math.max(...monthly.map((m) => m.total), 1);
  const filteredFees = filterMonth ? fees.filter((f) => f.month === filterMonth) : fees;
  const adhocFees = filteredFees.filter((f) => f.section === "adhoc");
  const packFees = filteredFees.filter((f) => f.section === "packaging");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">3PL Costs</h1>
          <p className="text-sm text-muted-foreground">Ship Sidekick invoice tracking</p>
        </div>
        <div className="flex gap-2">
          <Link href="/inventory"><Button variant="outline" size="sm">← Inventory</Button></Link>
          <label className="cursor-pointer">
            <span className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors">
              <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload CSV
            </span>
            <input type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      {uploadMsg && (
        <div className="rounded-lg border p-3 text-sm text-muted-foreground">{uploadMsg}</div>
      )}

      {!monthly.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No 3PL cost data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a Ship Sidekick invoice CSV or run: <code>python -m src.main import-3pl path/to/file.csv</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">
                  {mtd?.month === new Date().toISOString().slice(0, 7) ? "MTD" : mtd?.month}
                </p>
                <p className="text-2xl font-semibold tabular-nums">${fmtI(mtd?.total ?? 0)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Last Full Month</p>
                <p className="text-2xl font-semibold tabular-nums">${fmtI(lastFull?.total ?? 0)}</p>
                {priorFull && priorFull.total > 0 && lastFull && (
                  <p className={`text-xs font-medium ${lastFull.total > priorFull.total ? "text-red-500" : "text-emerald-500"}`}>
                    {pct(((lastFull.total / priorFull.total) - 1) * 100)} vs {priorFull.month}
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Shipping Share</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {lastFull && lastFull.total > 0 ? `${Math.round((lastFull.shipping / lastFull.total) * 100)}%` : "—"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Storage Share</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {lastFull && lastFull.total > 0 ? `${Math.round((catBreakdown(lastFull).storage / lastFull.total) * 100)}%` : "—"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Monthly chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Monthly Costs by Category</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-end gap-2" style={{ height: "180px" }}>
                {monthly.map((m) => {
                  const bd = catBreakdown(m);
                  const barH = chartMax > 0 ? (m.total / chartMax) * 180 : 0;
                  const segments = CATS.map((c) => ({
                    ...c,
                    value: bd[c.key as keyof typeof bd] ?? 0,
                  })).filter((s) => s.value > 0);
                  return (
                    <div key={m.month} className="flex-1 flex flex-col justify-end items-center min-w-0"
                      title={`${m.month}\n${segments.map((s) => `${s.label}: $${fmt(s.value)}`).join("\n")}\nTotal: $${fmt(m.total)}`}>
                      <div className="w-full flex flex-col" style={{ height: `${barH}px` }}>
                        {segments.map((s) => {
                          const h = m.total > 0 ? (s.value / m.total) * barH : 0;
                          return <div key={s.key} className={`w-full ${s.color} first:rounded-t-sm`} style={{ height: `${h}px` }} />;
                        })}
                      </div>
                      <span className="text-[9px] text-muted-foreground mt-1 truncate w-full text-center">
                        {m.month.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-3 justify-center">
                {CATS.map((c) => (
                  <span key={c.key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className={`inline-block h-2 w-2 rounded-sm ${c.color}`} /> {c.label}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Monthly summary table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Monthly Summary</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Shipping</TableHead>
                    <TableHead className="text-right">Pick</TableHead>
                    <TableHead className="text-right">Order Fee</TableHead>
                    <TableHead className="text-right">Packaging</TableHead>
                    <TableHead className="text-right">Storage</TableHead>
                    <TableHead className="text-right">Acct Mgmt</TableHead>
                    <TableHead className="text-right">Ad-hoc</TableHead>
                    <TableHead className="text-right font-semibold">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthly.map((m) => {
                    const storage = m.storage_shelf + m.storage_bin_med + m.storage_pallet + m.storage_bin_sm;
                    return (
                      <TableRow key={m.month} className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setFilterMonth(filterMonth === m.month ? null : m.month)}>
                        <TableCell className="font-medium">
                          {m.month}
                          {filterMonth === m.month && <Badge variant="secondary" className="ml-1.5 text-[9px]">filtered</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(m.shipping)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(m.pick)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(m.order_fee)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(m.packaging)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(storage)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(m.account_mgmt)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${m.adhoc < 0 ? "text-emerald-500" : ""}`}>
                          ${fmt(m.adhoc)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">${fmt(m.total)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Cost per order */}
          {orderStats.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Cost per Order (estimated from $2 order fee)</CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">Total/Order</TableHead>
                      <TableHead className="text-right">Shipping/Order</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderStats.map((o) => (
                      <TableRow key={o.month}>
                        <TableCell className="font-medium">{o.month}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtI(o.orders)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(o.total_per_order)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(o.shipping_per_order)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Insights */}
          {insights.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" /> Insights
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {insights.map((ins, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {ins.type === "warn" ? (
                        <TrendingUp className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      )}
                      <span>{ins.text}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Fee drill-down */}
          {(adhocFees.length > 0 || packFees.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {adhocFees.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">
                      Ad-hoc Fees {filterMonth && `(${filterMonth})`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {!filterMonth && <TableHead>Month</TableHead>}
                          <TableHead>Fee</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {adhocFees.sort((a, b) => b.amount - a.amount).map((f, i) => (
                          <TableRow key={i}>
                            {!filterMonth && <TableCell className="text-xs">{f.month}</TableCell>}
                            <TableCell className="text-sm">{f.fee_name}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtI(f.qty)}</TableCell>
                            <TableCell className={`text-right tabular-nums ${f.amount < 0 ? "text-emerald-500" : ""}`}>
                              ${fmt(f.amount)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
              {packFees.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">
                      Packaging Fees {filterMonth && `(${filterMonth})`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {!filterMonth && <TableHead>Month</TableHead>}
                          <TableHead>Type</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {packFees.sort((a, b) => b.amount - a.amount).map((f, i) => (
                          <TableRow key={i}>
                            {!filterMonth && <TableCell className="text-xs">{f.month}</TableCell>}
                            <TableCell className="text-sm">{f.fee_name}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmtI(f.qty)}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmt(f.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            3PL cost tracking — operational only, not sales-tax nexus. Click a month row to filter fee drill-down.
          </p>
        </>
      )}
    </div>
  );
}
