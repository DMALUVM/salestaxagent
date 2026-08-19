"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, TrendingUp, DollarSign, Eye, ShoppingCart, AlertTriangle } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface TrafficDay {
  date: string; ordered_product_sales: number; units_ordered: number;
  sessions: number; page_views: number; unit_session_pct: number; buy_box_pct: number;
}
interface AsinTraffic {
  parent_asin: string; child_asin: string | null;
  product_name: string | null;
  units_ordered: number; ordered_product_sales: number;
  sessions: number; unit_session_pct: number; buy_box_pct: number;
}
interface Reimbursement {
  approval_date: string; reimbursement_id: string; reason: string | null;
  sku: string | null; product_name: string | null;
  amount_total: number; qty_total: number;
}

export default function AmazonOpsPage() {
  interface SnsSeller { week_start: string; week_end: string; active_subscriptions: number; shipped_units: number; total_revenue: number; revenue_penetration: number; not_delivered_oos: number; lost_revenue_oos: number; }
  interface SnsOffer { asin: string; sku: string | null; active_subscriptions: number; shipped_units: number; total_revenue: number; }
  const [data, setData] = useState<{ traffic: TrafficDay[]; asinTraffic: AsinTraffic[]; reimbursements: Reimbursement[]; snsSeller: SnsSeller[]; snsOffers: SnsOffer[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/amazon-ops").then((r) => r.json()).then((d) => {
      setData(d); setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const { last7, last30, reimbTotal30, reimbByReason } = useMemo(() => {
    if (!data) return { last7: null, last30: null, reimbTotal30: 0, reimbByReason: [] };
    const traffic = [...(data.traffic ?? [])].sort((a, b) => b.date.localeCompare(a.date));
    const t7 = traffic.slice(0, 7);
    const t30 = traffic;

    const avg = (arr: TrafficDay[], key: keyof TrafficDay) =>
      arr.length ? arr.reduce((s, r) => s + Number(r[key] ?? 0), 0) / arr.length : 0;
    const sum = (arr: TrafficDay[], key: keyof TrafficDay) =>
      arr.reduce((s, r) => s + Number(r[key] ?? 0), 0);

    const now = new Date();
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const reimb30 = (data.reimbursements ?? []).filter((r) => r.approval_date >= d30.toISOString());
    const rt = reimb30.reduce((s, r) => s + Number(r.amount_total ?? 0), 0);

    const reasons: Record<string, number> = {};
    for (const r of reimb30) {
      const key = r.reason || "Unknown";
      reasons[key] = (reasons[key] ?? 0) + Number(r.amount_total ?? 0);
    }

    return {
      last7: {
        sales: sum(t7, "ordered_product_sales"),
        units: sum(t7, "units_ordered"),
        sessions: sum(t7, "sessions"),
        convRate: avg(t7, "unit_session_pct"),
        buyBox: avg(t7, "buy_box_pct"),
      },
      last30: {
        sales: sum(t30, "ordered_product_sales"),
        units: sum(t30, "units_ordered"),
        sessions: sum(t30, "sessions"),
        convRate: avg(t30, "unit_session_pct"),
        buyBox: avg(t30, "buy_box_pct"),
      },
      reimbTotal30: rt,
      reimbByReason: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
    };
  }, [data]);

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const traffic = data?.traffic ?? [];
  const asinTraffic = data?.asinTraffic ?? [];
  const reimbursements = data?.reimbursements ?? [];
  const hasTraffic = traffic.length > 0;
  const hasReimb = reimbursements.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Amazon Ops</h1>
        <p className="text-sm text-muted-foreground">
          Sales & Traffic (Brand Analytics) + Reimbursements
        </p>
      </div>

      {!hasTraffic && !hasReimb ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ShoppingCart className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No Amazon ops data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run: <code>python -m src.main spapi-traffic --days 30</code> and
              <code> python -m src.main spapi-reimbursements --days 90</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Traffic summary cards */}
          {hasTraffic && (
            <>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-muted-foreground uppercase">Sales (7d)</p>
                    <p className="text-2xl font-semibold tabular-nums">${fmt(last7?.sales ?? 0)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-muted-foreground uppercase">Units (7d)</p>
                    <p className="text-2xl font-semibold tabular-nums">{fmt(last7?.units ?? 0)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-muted-foreground uppercase">Sessions (7d)</p>
                    <p className="text-2xl font-semibold tabular-nums">{fmt(last7?.sessions ?? 0)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-muted-foreground uppercase">Conv. Rate</p>
                    <p className="text-2xl font-semibold tabular-nums">{(last7?.convRate ?? 0).toFixed(1)}%</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-[10px] text-muted-foreground uppercase">Buy Box</p>
                    <p className="text-2xl font-semibold tabular-nums">{(last7?.buyBox ?? 0).toFixed(1)}%</p>
                  </CardContent>
                </Card>
              </div>

              {/* Daily traffic table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Daily Sales & Traffic</CardTitle>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Sales</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Sessions</TableHead>
                        <TableHead className="text-right">Conv %</TableHead>
                        <TableHead className="text-right">Buy Box %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {traffic.slice(0, 14).map((d) => (
                        <TableRow key={d.date}>
                          <TableCell className="font-medium text-xs">{d.date}</TableCell>
                          <TableCell className="text-right tabular-nums">${fmtD(d.ordered_product_sales)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(d.units_ordered)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(d.sessions)}</TableCell>
                          <TableCell className="text-right tabular-nums">{d.unit_session_pct.toFixed(1)}%</TableCell>
                          <TableCell className="text-right tabular-nums">{d.buy_box_pct.toFixed(1)}%</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* ASIN traffic */}
              {asinTraffic.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Product Performance (period)</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Units</TableHead>
                          <TableHead className="text-right">Sales</TableHead>
                          <TableHead className="text-right">Sessions</TableHead>
                          <TableHead className="text-right">Conv %</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {asinTraffic.map((a) => (
                          <TableRow key={a.parent_asin}>
                            <TableCell>
                              <div className="font-medium text-sm">
                                {a.product_name || a.parent_asin}
                              </div>
                              <span className="text-[10px] text-muted-foreground">{a.parent_asin}</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(a.units_ordered)}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmtD(a.ordered_product_sales)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(a.sessions)}</TableCell>
                            <TableCell className="text-right tabular-nums">{a.unit_session_pct.toFixed(1)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* Reimbursements */}
          {hasReimb && (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">FBA Reimbursements (30d)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-3 mb-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Total Reimbursed</p>
                      <p className="text-2xl font-semibold tabular-nums text-emerald-600">${fmtD(reimbTotal30)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Top Reason</p>
                      <p className="text-lg font-semibold">{reimbByReason[0]?.[0] || "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Events</p>
                      <p className="text-2xl font-semibold tabular-nums">{reimbursements.filter((r) => r.approval_date >= new Date(Date.now() - 30 * 86400000).toISOString()).length}</p>
                    </div>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reimbursements.slice(0, 20).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs tabular-nums">{r.approval_date?.slice(0, 10)}</TableCell>
                          <TableCell className="text-xs font-medium">{r.sku || "—"}</TableCell>
                          <TableCell className="text-xs">{r.reason || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums text-emerald-600">${fmtD(r.amount_total)}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.qty_total}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}

          {/* Subscribe & Save */}
          {(data?.snsSeller?.length ?? 0) > 0 && (() => {
            // Sort ascending for chart, filter out partial weeks (< 7 days span)
            const allWeeks = [...(data?.snsSeller ?? [])]
              .filter((w) => {
                const s = new Date(w.week_start + "T00:00:00");
                const e = new Date(w.week_end + "T00:00:00");
                return (e.getTime() - s.getTime()) >= 6 * 86400000;
              })
              .sort((a, b) => a.week_start.localeCompare(b.week_start));
            const latest = allWeeks[allWeeks.length - 1];
            const prior = allWeeks.length > 1 ? allWeeks[allWeeks.length - 2] : null;
            const snsOffers = data?.snsOffers ?? [];

            if (!latest) return null;

            const wow = (cur: number, prev: number | undefined) =>
              prev && prev > 0 ? Math.round(((cur / prev) - 1) * 100) : null;
            const subWow = wow(latest.active_subscriptions, prior?.active_subscriptions);
            const shipWow = wow(latest.shipped_units, prior?.shipped_units);
            const revWow = wow(latest.total_revenue, prior?.total_revenue);

            const chartMax = Math.max(...allWeeks.map((w) => w.active_subscriptions), 1);
            const revMax = Math.max(...allWeeks.map((w) => w.total_revenue), 1);

            function WowBadge({ val, invert }: { val: number | null; invert?: boolean }) {
              if (val === null) return null;
              const good = invert ? val <= 0 : val >= 0;
              return (
                <span className={`text-xs font-medium ${good ? "text-emerald-500" : "text-red-500"}`}>
                  {val >= 0 ? "+" : ""}{val}%
                </span>
              );
            }

            return (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Subscribe & Save</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Summary cards */}
                  <div className="grid gap-3 sm:grid-cols-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Active Subscriptions</p>
                      <p className="text-2xl font-semibold tabular-nums">{fmt(latest.active_subscriptions)}</p>
                      <WowBadge val={subWow} />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Shipped Units (wk)</p>
                      <p className="text-2xl font-semibold tabular-nums">{fmt(latest.shipped_units)}</p>
                      <WowBadge val={shipWow} />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Revenue (wk)</p>
                      <p className="text-2xl font-semibold tabular-nums">${fmtD(latest.total_revenue)}</p>
                      <WowBadge val={revWow} />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Rev Penetration</p>
                      <p className="text-2xl font-semibold tabular-nums">{latest.revenue_penetration.toFixed(1)}%</p>
                    </div>
                  </div>

                  {latest.not_delivered_oos > 0 && (
                    <div className="flex items-center gap-2 text-xs text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {latest.not_delivered_oos} units not delivered due to OOS
                      {latest.lost_revenue_oos > 0 && ` ($${fmtD(latest.lost_revenue_oos)} lost)`}
                    </div>
                  )}

                  {/* Weekly trend chart */}
                  {allWeeks.length > 3 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Subscription Growth</p>
                      <div className="flex items-end gap-px" style={{ height: "80px" }}>
                        {allWeeks.map((w) => {
                          const h = chartMax > 0 ? (w.active_subscriptions / chartMax) * 80 : 0;
                          return (
                            <div key={w.week_start} className="flex-1 flex flex-col justify-end min-w-0"
                              title={`Wk ending ${w.week_end}\nSubs: ${fmt(w.active_subscriptions)}\nShipped: ${fmt(w.shipped_units)}\nRev: $${fmtD(w.total_revenue)}`}>
                              <div className="w-full rounded-t-sm bg-violet-500" style={{ height: `${h}px` }} />
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
                        <span>{allWeeks[0].week_end}</span>
                        <span>{allWeeks[allWeeks.length - 1].week_end}</span>
                      </div>
                    </div>
                  )}

                  {/* Per-offer table */}
                  {snsOffers.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Subs</TableHead>
                          <TableHead className="text-right">Shipped</TableHead>
                          <TableHead className="text-right">Revenue</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {snsOffers.slice(0, 10).map((o) => (
                          <TableRow key={o.asin}>
                            <TableCell>
                              <span className="text-sm font-medium">{o.sku || o.asin}</span>
                              <span className="ml-1.5 text-[10px] text-muted-foreground">{o.asin}</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(o.active_subscriptions)}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(o.shipped_units)}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmtD(o.total_revenue)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}

                  <p className="text-[10px] text-muted-foreground">
                    Week ending {latest.week_end} · {allWeeks.length} weeks stored · Amazon Replenishment API
                  </p>
                </CardContent>
              </Card>
            );
          })()}

          <p className="text-xs text-muted-foreground">
            Sales & Traffic data from Brand Analytics (SP-API). These are aggregated marketplace metrics, not order-level CRM data.
            Reimbursements are Amazon-initiated credits for lost/damaged inventory.
          </p>
        </>
      )}
    </div>
  );
}
