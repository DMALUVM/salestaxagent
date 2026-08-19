"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, DollarSign, Target, AlertTriangle, TrendingUp, Search, CheckCircle, X } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface Campaign {
  date: string; campaign_id: string; campaign_name: string;
  spend: number; sales_14d: number; orders_14d: number;
  clicks: number; impressions: number; acos: number; roas: number; ctr: number; cvr: number;
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

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200",
  P1: "bg-amber-50 text-amber-700 border-amber-200",
  P2: "bg-blue-50 text-blue-700 border-blue-200",
};
const TYPE_LABELS: Record<string, string> = {
  NEGATE_SEARCH_TERM: "Negate",
  HARVEST_SEARCH_TERM: "Harvest",
  REDUCE_BID: "Reduce bid",
  INCREASE_BID: "Increase bid",
  STARVE_OOS: "OOS pause",
  WASTED_SPEND_ROLLUP: "Waste",
};

export default function PPCPage() {
  const [data, setData] = useState<{
    campaigns: Campaign[]; searchTerms: SearchTerm[];
    recommendations: Rec[]; totalSales7d: number; totalSales30d: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"actions" | "search" | "campaigns">("actions");

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    fetch("/api/ppc").then((r) => r.json()).then((d) => {
      setData(d); setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const [generating, setGenerating] = useState(false);

  async function updateRec(id: string, status: string) {
    await fetch("/api/ppc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", target_acos: 30 }),
      });
      const result = await resp.json();
      if (result.ok) {
        // Reload all data
        const fresh = await fetch("/api/ppc").then((r) => r.json());
        setData(fresh);
        setTab("actions");
      }
    } catch { /* ok */ }
    setGenerating(false);
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const campaigns = data?.campaigns ?? [];
  const searchTerms = data?.searchTerms ?? [];
  const recs = (data?.recommendations ?? []).filter((r) => r.status === "open");

  // Aggregate 7d metrics
  const now = new Date();
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
  const d7iso = d7.toISOString().slice(0, 10);
  const recent = campaigns.filter((c) => c.date >= d7iso);

  const spend7d = recent.reduce((s, c) => s + Number(c.spend ?? 0), 0);
  const adSales7d = recent.reduce((s, c) => s + Number(c.sales_14d ?? 0), 0);
  const acos7d = adSales7d > 0 ? (spend7d / adSales7d) * 100 : 0;
  const roas7d = spend7d > 0 ? adSales7d / spend7d : 0;
  const tacos7d = (data?.totalSales7d ?? 0) > 0 ? (spend7d / data!.totalSales7d) * 100 : 0;

  const wastedTotal = searchTerms.filter((s) => s.orders_14d === 0).reduce((sum, s) => sum + Number(s.spend ?? 0), 0);

  const hasData = campaigns.length > 0 || searchTerms.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Amazon PPC</h1>
        <p className="text-sm text-muted-foreground">
          Advertising intelligence · Decision support · Phase 1: Read + Recommend
        </p>
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
          {/* KPI strip */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Spend (7d)</p>
                <p className="text-2xl font-semibold tabular-nums">${fmtD(spend7d)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Ad Sales (7d)</p>
                <p className="text-2xl font-semibold tabular-nums">${fmt(Math.round(adSales7d))}</p>
              </CardContent>
            </Card>
            <Card className={acos7d > 35 ? "border-red-500/30" : acos7d > 25 ? "border-amber-500/30" : "border-emerald-500/30"}>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{acos7d.toFixed(1)}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ROAS</p>
                <p className="text-2xl font-semibold tabular-nums">{roas7d.toFixed(1)}x</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">TACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{tacos7d.toFixed(1)}%</p>
                <p className="text-[10px] text-muted-foreground">ad spend / total sales</p>
              </CardContent>
            </Card>
          </div>

          {/* Wasted spend + generate actions */}
          <div className="flex gap-3">
            {wastedTotal > 5 && (
              <Card className="border-red-500/30 flex-1 cursor-pointer" onClick={() => setTab("actions")}>
                <CardContent className="p-4 flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
                  <div>
                    <p className="font-semibold text-red-600">${fmtD(wastedTotal)} wasted</p>
                    <p className="text-xs text-muted-foreground">
                      {searchTerms.filter((s) => s.orders_14d === 0 && s.spend >= 5).length} terms with $5+ spend, 0 orders → click for actions
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
            <Button variant="outline" onClick={generateRecs} disabled={generating}
              className="shrink-0 self-center">
              {generating ? "Generating..." : "Generate Recommendations"}
            </Button>
          </div>

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
                      <TableRow key={i} className={s.orders_14d === 0 && s.spend > 5 ? "bg-red-50/50" : ""}>
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
                    {(() => {
                      // Aggregate by campaign
                      const agg: Record<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }> = {};
                      for (const c of recent) {
                        const k = c.campaign_name;
                        if (!agg[k]) agg[k] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
                        agg[k].spend += Number(c.spend ?? 0);
                        agg[k].sales += Number(c.sales_14d ?? 0);
                        agg[k].orders += Number(c.orders_14d ?? 0);
                        agg[k].clicks += Number(c.clicks ?? 0);
                        agg[k].impressions += Number(c.impressions ?? 0);
                      }
                      return Object.entries(agg).sort((a, b) => b[1].spend - a[1].spend).map(([name, d]) => {
                        const acos = d.sales > 0 ? (d.spend / d.sales) * 100 : 0;
                        const roas = d.spend > 0 ? d.sales / d.spend : 0;
                        const cvr = d.clicks > 0 ? (d.orders / d.clicks) * 100 : 0;
                        return (
                          <TableRow key={name}>
                            <TableCell className="text-xs font-medium truncate max-w-[250px]">{name}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmtD(d.spend)}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmt(Math.round(d.sales))}</TableCell>
                            <TableCell className={`text-right tabular-nums ${acos > 35 ? "text-red-500" : ""}`}>{acos.toFixed(0)}%</TableCell>
                            <TableCell className="text-right tabular-nums">{roas.toFixed(1)}x</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(d.clicks)}</TableCell>
                            <TableCell className="text-right tabular-nums">{cvr.toFixed(1)}%</TableCell>
                          </TableRow>
                        );
                      });
                    })()}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              Decision support only — user is responsible for all Ads Console changes.
              TACOS = ad spend / total sales (not ad sales). ACOS uses 14-day attribution.
              Phase 1: no auto-bidding; recommendations must be manually applied in Seller Central.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
