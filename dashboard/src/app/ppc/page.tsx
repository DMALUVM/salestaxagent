"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, Target, AlertTriangle, CheckCircle, X, RefreshCw } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface KPIs {
  spend: number; adSales: number; orders: number; clicks: number;
  impressions: number; acos: number; roas: number; cpc: number;
  cvr: number; totalSales: number; tacos: number;
}
interface DailyPoint { date: string; spend: number; ad_sales: number; orders: number; clicks: number; impressions: number; }
interface CampaignAgg {
  campaign_name: string; spend: number; sales: number; orders: number;
  clicks: number; impressions: number; acos: number; roas: number; cvr: number;
}
interface SearchTerm {
  search_term: string; campaign_name: string; keyword: string; match_type: string;
  spend: number; sales_14d: number; orders_14d: number; clicks: number; acos: number;
}
interface Rec {
  id: string; type: string; priority: string; impact_estimate: number;
  entity_name: string; campaign_name: string; suggested_action: string;
  evidence: string | Record<string, unknown>; status: string;
}
interface PPCData {
  kpi7: KPIs | null; kpi7Days: number;
  kpi14: KPIs | null; kpi14Days: number;
  kpi30: KPIs | null; kpi30Days: number;
  dailySeries: DailyPoint[];
  dateMin: string | null; dateMax: string | null; daysInDb: number;
  campaigns: CampaignAgg[]; searchTerms: SearchTerm[];
  recommendations: Rec[]; lastSync: string | null;
}

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800",
  P1: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800",
  P2: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-800",
};
const TYPE_LABELS: Record<string, string> = {
  NEGATE_SEARCH_TERM: "Negate",
  HARVEST_SEARCH_TERM: "Harvest",
  REDUCE_BID: "Reduce bid",
  INCREASE_BID: "Increase bid",
  STARVE_OOS: "OOS pause",
  WASTED_SPEND_ROLLUP: "Waste",
};

type Range = "7d" | "14d" | "30d";

export default function PPCPage() {
  const [data, setData] = useState<PPCData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"actions" | "search" | "campaigns">("actions");
  const [range, setRange] = useState<Range>("7d");
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const d = await fetch("/api/ppc").then((r) => r.json());
      setData(d);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    loadData();
  }, [loadData]);

  async function updateRec(id: string, status: string) {
    await fetch("/api/ppc", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (data) {
      setData({
        ...data,
        recommendations: data.recommendations.map((r) =>
          r.id === id ? { ...r, status } : r
        ),
      });
    }
  }

  async function generateRecs() {
    setGenerating(true);
    try {
      const resp = await fetch("/api/ppc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", target_acos: 30 }),
      });
      const result = await resp.json();
      if (result.ok) { await loadData(); setTab("actions"); }
    } catch { /* */ }
    setGenerating(false);
  }

  async function syncAds(days: number) {
    setSyncing(true);
    try {
      await fetch("/api/ppc/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      await loadData();
    } catch { /* */ }
    setSyncing(false);
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const kpi = range === "7d" ? data?.kpi7 : range === "14d" ? data?.kpi14 : data?.kpi30;
  const kpiDays = range === "7d" ? data?.kpi7Days : range === "14d" ? data?.kpi14Days : data?.kpi30Days;
  const rangeDays = range === "7d" ? 7 : range === "14d" ? 14 : 30;
  const series = data?.dailySeries ?? [];
  const searchTerms = data?.searchTerms ?? [];
  const recs = (data?.recommendations ?? []).filter((r) => r.status === "open");
  const campaigns = data?.campaigns ?? [];
  const hasData = series.length > 0 || searchTerms.length > 0;

  const wastedTotal = searchTerms.filter((s) => s.orders_14d === 0).reduce((sum, s) => sum + Number(s.spend ?? 0), 0);

  // Format last sync
  const lastSyncLabel = data?.lastSync
    ? new Date(data.lastSync).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "never";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Amazon PPC</h1>
          <p className="text-sm text-muted-foreground">
            Phase 1: Read + Recommend
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={generateRecs} disabled={generating || !hasData}>
            {generating ? "Generating..." : "Generate Recs"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => syncAds(14)} disabled={syncing}>
            <RefreshCw className={`mr-1 h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync 14D"}
          </Button>
        </div>
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Target className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No Ads data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run: <code>python -m src.main ads-sync --days 14</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Data freshness + range toggle */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Data: {data?.dateMin ?? "?"} → {data?.dateMax ?? "?"} · {data?.daysInDb ?? 0} days in DB · last sync {lastSyncLabel}
              {(kpiDays ?? 0) < rangeDays && (kpiDays ?? 0) > 0 && (
                <span className="ml-2 text-amber-500">
                  ({kpiDays}d of data in {range} window)
                </span>
              )}
            </p>
            <div className="flex gap-1 rounded-md border p-0.5">
              {(["7d", "14d", "30d"] as const).map((r) => (
                <button key={r} onClick={() => setRange(r)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}>
                  {r.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* KPI strip */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Spend ({range})</p>
                <p className="text-2xl font-semibold tabular-nums">${fmtD(kpi?.spend ?? 0)}</p>
                {(kpi?.spend ?? 0) > 0 && (kpiDays ?? 0) > 0 && (
                  <p className="text-[10px] text-muted-foreground">${fmtD((kpi!.spend) / kpiDays!)}/day avg</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Ad Sales ({range})</p>
                <p className="text-2xl font-semibold tabular-nums">${fmt(Math.round(kpi?.adSales ?? 0))}</p>
              </CardContent>
            </Card>
            <Card className={(kpi?.acos ?? 0) > 35 ? "border-red-500/30" : (kpi?.acos ?? 0) > 25 ? "border-amber-500/30" : "border-emerald-500/30"}>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.acos ?? 0).toFixed(1)}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ROAS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.roas ?? 0).toFixed(1)}x</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">TACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.tacos ?? 0).toFixed(1)}%</p>
                <p className="text-[10px] text-muted-foreground">ad spend / Amazon sales</p>
              </CardContent>
            </Card>
          </div>

          {/* Trend chart */}
          {series.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Daily Trends ({series.length} days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TrendChart series={series} />
              </CardContent>
            </Card>
          )}

          {/* Wasted spend alert */}
          {wastedTotal > 5 && (
            <Card className="border-red-500/30 cursor-pointer" onClick={() => setTab("actions")}>
              <CardContent className="p-4 flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
                <div>
                  <p className="font-semibold text-red-600">${fmtD(wastedTotal)} wasted</p>
                  <p className="text-xs text-muted-foreground">
                    {searchTerms.filter((s) => s.orders_14d === 0 && s.spend >= 5).length} terms with $5+ spend, 0 orders
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Tab bar */}
          <div className="flex gap-1">
            {(["actions", "search", "campaigns"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  tab === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}>
                {t === "actions" ? `Actions (${recs.length})` : t === "search" ? "Search Terms" : "Campaigns"}
              </button>
            ))}
          </div>

          {/* Actions queue */}
          {tab === "actions" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                {recs.length === 0 ? (
                  <div className="p-4 text-center">
                    <p className="text-sm text-muted-foreground">No open recommendations.</p>
                    <Button variant="outline" size="sm" className="mt-2" onClick={generateRecs} disabled={generating}>
                      {generating ? "Generating..." : "Generate Recommendations"}
                    </Button>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Priority</TableHead>
                        <TableHead className="w-24">Type</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead>Campaign</TableHead>
                        <TableHead className="text-right">Impact</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] ${PRIORITY_COLORS[r.priority] ?? ""}`}>
                              {r.priority}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs font-medium">{TYPE_LABELS[r.type] ?? r.type}</TableCell>
                          <TableCell className="text-xs max-w-[200px] truncate" title={r.suggested_action}>
                            {r.entity_name.slice(0, 40)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground truncate max-w-[150px]">{r.campaign_name}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium text-red-600">${fmtD(r.impact_estimate)}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                                title="Mark applied" onClick={() => updateRec(r.id, "applied")}>
                                <CheckCircle className="h-3 w-3 text-emerald-500" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                                title="Dismiss" onClick={() => updateRec(r.id, "dismissed")}>
                                <X className="h-3 w-3 text-muted-foreground" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {/* Search terms */}
          {tab === "search" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Search Term</TableHead>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">ACOS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {searchTerms.slice(0, 50).map((s, i) => (
                      <TableRow key={i} className={s.orders_14d === 0 && s.spend > 5 ? "bg-red-50/50 dark:bg-red-950/20" : ""}>
                        <TableCell className="text-xs font-medium max-w-[200px] truncate">{s.search_term}</TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[150px]">{s.campaign_name}</TableCell>
                        <TableCell className="text-xs">{s.match_type}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(s.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(s.sales_14d)}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.orders_14d}</TableCell>
                        <TableCell className={`text-right tabular-nums ${s.acos > 35 ? "text-red-500" : s.acos > 25 ? "text-amber-500" : "text-emerald-500"}`}>
                          {s.acos > 0 ? `${s.acos.toFixed(0)}%` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Campaigns */}
          {tab === "campaigns" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">ACOS</TableHead>
                      <TableHead className="text-right">ROAS</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">CVR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaigns.map((d) => (
                      <TableRow key={d.campaign_name}>
                        <TableCell className="text-xs font-medium truncate max-w-[250px]">{d.campaign_name}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(d.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(Math.round(d.sales))}</TableCell>
                        <TableCell className={`text-right tabular-nums ${d.acos > 35 ? "text-red-500" : ""}`}>{d.acos.toFixed(0)}%</TableCell>
                        <TableCell className="text-right tabular-nums">{d.roas.toFixed(1)}x</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(d.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.cvr.toFixed(1)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              Decision support only — user is responsible for all Ads Console changes.
              TACOS = ad spend / Amazon sales. ACOS uses 14-day attribution.
              Phase 1: no auto-bidding; recommendations must be manually applied in Seller Central.
            </span>
          </div>
        </>
      )}
    </div>
  );
}


/* ── Trend Chart ─────────────────────────────────────────────── */

function TrendChart({ series }: { series: DailyPoint[] }) {
  const maxSpend = Math.max(...series.map((d) => d.spend), 1);
  const maxSales = Math.max(...series.map((d) => d.ad_sales), 1);
  const chartH = 140;

  return (
    <div>
      {/* Spend + Ad Sales bars */}
      <div className="flex gap-px items-end" style={{ height: `${chartH}px` }}>
        {series.map((day) => {
          const spendH = (day.spend / maxSpend) * chartH;
          const salesH = (day.ad_sales / maxSales) * chartH;
          const acos = day.ad_sales > 0 ? (day.spend / day.ad_sales) * 100 : 0;
          return (
            <div key={day.date} className="flex-1 flex gap-px min-w-0"
              title={`${day.date}\nSpend: $${day.spend.toFixed(2)}\nAd Sales: $${day.ad_sales.toFixed(2)}\nACOS: ${acos.toFixed(1)}%\nOrders: ${day.orders}\nClicks: ${day.clicks}`}>
              <div className="flex-1 flex flex-col justify-end">
                {spendH > 0 && <div className="w-full rounded-t-sm bg-red-400 dark:bg-red-500" style={{ height: `${spendH}px` }} />}
                {spendH === 0 && <div className="w-full bg-muted" style={{ height: "1px" }} />}
              </div>
              <div className="flex-1 flex flex-col justify-end">
                {salesH > 0 && <div className="w-full rounded-t-sm bg-emerald-400 dark:bg-emerald-500" style={{ height: `${salesH}px` }} />}
                {salesH === 0 && <div className="w-full bg-muted" style={{ height: "1px" }} />}
              </div>
            </div>
          );
        })}
      </div>
      {/* Labels */}
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{series[0]?.date.slice(5)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-red-400 dark:bg-red-500" /> Spend</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-400 dark:bg-emerald-500" /> Ad Sales</span>
        </span>
        <span>{series[series.length - 1]?.date.slice(5)}</span>
      </div>

      {/* ACOS line (text row) */}
      <div className="flex gap-px mt-2">
        {series.map((day) => {
          const acos = day.ad_sales > 0 ? (day.spend / day.ad_sales) * 100 : 0;
          return (
            <div key={day.date} className="flex-1 text-center">
              <span className={`text-[9px] tabular-nums ${acos > 35 ? "text-red-500" : acos > 25 ? "text-amber-500" : "text-emerald-500"}`}>
                {acos > 0 ? `${acos.toFixed(0)}%` : ""}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-center text-[9px] text-muted-foreground mt-0.5">ACOS by day</p>
    </div>
  );
}
