"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, TrendingUp, AlertTriangle, Package, Calculator } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface ForecastResult {
  sku: string; asin: string; product_name: string;
  start_date: string; end_date: string; num_weeks: number; safety_pct: number;
  expected_units: number; coverage_units: number; low_band: number; high_band: number;
  methods: {
    A_naive_runrate: number; B_seasonal_yoy: number; C_sns_plus_organic: number;
    spread_pct: number; spread_warning: boolean;
  };
  breakdown: {
    blended_daily_velocity: number; sns_weekly_shipped: number; sns_active_subs: number;
    organic_daily: number; return_rate_pct: number; holiday_forecast_weeks: number;
  };
  data_quality: {
    velocity_windows: number; has_holiday_forecast: boolean; has_sns_data: boolean;
    seasonality_weeks: number;
  };
  holidays: string[];
  weeks: Array<{
    week_start: string; week_end: string; iso_week: number; days: number;
    naive: number; seasonal: number; sns_organic: number; source: string; multiplier: number;
  }>;
  disclaimer: string;
  error?: string;
}

export default function ForecastPage() {
  const [sku, setSku] = useState("DDPE0004Shop");
  const [endDate, setEndDate] = useState("2027-03-31");
  const [safety, setSafety] = useState("15");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skuList, setSkuList] = useState<string[]>([]);

  // Load available SKUs
  useEffect(() => {
    if (!isConfigured()) return;
    fetch("/api/inventory").then((r) => r.json()).then((d) => {
      const skus = new Set<string>();
      for (const s of d.velocity ?? []) if (s.sku) skus.add(s.sku);
      for (const s of d.snapshots ?? []) if (s.sku) skus.add(s.sku);
      setSkuList([...skus].sort());
    }).catch(() => {});
  }, []);

  async function runForecast() {
    setLoading(true); setError(null); setResult(null);
    try {
      const params = new URLSearchParams({ sku, end: endDate, safety: String(Number(safety) / 100) });
      const resp = await fetch(`/api/forecast-sku?${params}`);
      const data = await resp.json();
      if (data.error) { setError(data.error); }
      else { setResult(data); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">SKU Demand Forecast</h1>
        <p className="text-sm text-muted-foreground">
          How many units do I need through a target date?
        </p>
      </div>

      {/* Input form */}
      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="text-xs font-medium">SKU</label>
              <Select value={sku} onChange={(e) => setSku(e.target.value)} className="mt-1">
                {skuList.length > 0 ? (
                  skuList.map((s) => <option key={s} value={s}>{s}</option>)
                ) : (
                  <option value={sku}>{sku}</option>
                )}
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium">End Date</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium">Safety Stock %</label>
              <Input type="number" min="0" max="50" value={safety} onChange={(e) => setSafety(e.target.value)} className="mt-1" />
            </div>
            <div className="flex items-end">
              <Button onClick={runForecast} disabled={loading} className="w-full">
                <Calculator className="mr-1.5 h-3.5 w-3.5" />
                {loading ? "Calculating..." : "Forecast"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <LoadingState />}

      {result && (
        <>
          {/* Headline */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Card className="border-primary/30">
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Expected Sales</p>
                <p className="text-2xl font-semibold tabular-nums">{fmt(result.expected_units)}</p>
                <p className="text-xs text-muted-foreground">{result.num_weeks} weeks</p>
              </CardContent>
            </Card>
            <Card className="border-emerald-500/30">
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Coverage (+{Number(safety)}%)</p>
                <p className="text-2xl font-semibold tabular-nums text-emerald-600">{fmt(result.coverage_units)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Low / High Band</p>
                <p className="text-lg font-semibold tabular-nums">{fmt(result.low_band)} – {fmt(result.high_band)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Product</p>
                <p className="text-sm font-semibold">{result.product_name}</p>
                <p className="text-[10px] text-muted-foreground">{result.asin}</p>
              </CardContent>
            </Card>
          </div>

          {/* Triple-check */}
          <Card className={result.methods.spread_warning ? "border-amber-500/30" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {result.methods.spread_warning && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                Triple-Check Cross-Validation
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">A) Naive Run-Rate</p>
                  <p className="text-lg font-semibold tabular-nums">{fmt(result.methods.A_naive_runrate)}</p>
                  <p className="text-[10px] text-muted-foreground">V30 × weeks (no seasonality)</p>
                </div>
                <div className="rounded-lg border border-primary/30 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">B) Seasonal + Holiday</p>
                  <p className="text-lg font-semibold tabular-nums text-primary">{fmt(result.methods.B_seasonal_yoy)}</p>
                  <p className="text-[10px] text-muted-foreground">Primary method — velocity × seasonality + forecast</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">C) SnS Floor + Organic</p>
                  <p className="text-lg font-semibold tabular-nums">{fmt(result.methods.C_sns_plus_organic)}</p>
                  <p className="text-[10px] text-muted-foreground">{result.breakdown.sns_weekly_shipped}/wk subs + organic × seasonal</p>
                </div>
              </div>
              {result.methods.spread_warning && (
                <p className="mt-2 text-xs text-amber-600">
                  Method spread {result.methods.spread_pct}% — holiday demand causes expected divergence from summer run-rate.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Demand Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Daily Velocity</p>
                  <p className="font-semibold">{result.breakdown.blended_daily_velocity} u/day</p>
                  <p className="text-[10px] text-muted-foreground">Blended V7/V30/V90</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">SnS Subscribers</p>
                  <p className="font-semibold">{fmt(result.breakdown.sns_active_subs)} active</p>
                  <p className="text-[10px] text-muted-foreground">{result.breakdown.sns_weekly_shipped} shipped/wk</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Return Rate</p>
                  <p className="font-semibold">{result.breakdown.return_rate_pct}%</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Data Quality</p>
                  <div className="flex gap-1 flex-wrap mt-0.5">
                    <Badge variant="outline" className={`text-[9px] ${result.data_quality.velocity_windows >= 2 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                      Vel: {result.data_quality.velocity_windows}/3
                    </Badge>
                    {result.data_quality.has_holiday_forecast && <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700">Holiday FC</Badge>}
                    {result.data_quality.has_sns_data && <Badge variant="outline" className="text-[9px] bg-emerald-50 text-emerald-700">SnS</Badge>}
                    <Badge variant="outline" className="text-[9px]">Seas: {result.data_quality.seasonality_weeks}wk</Badge>
                  </div>
                </div>
              </div>
              {result.holidays.length > 0 && (
                <div className="mt-3 space-y-1">
                  {result.holidays.map((h, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-amber-600">
                      <TrendingUp className="h-3 w-3" /> {h}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Weekly table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Weekly Projection</CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Week</TableHead>
                    <TableHead className="text-right">Naive</TableHead>
                    <TableHead className="text-right">Seasonal</TableHead>
                    <TableHead className="text-right">SnS+Org</TableHead>
                    <TableHead className="text-right">Mult</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.weeks.map((w) => (
                    <TableRow key={w.week_start} className={w.source === "forecast" ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}>
                      <TableCell className="text-xs tabular-nums">{w.week_start.slice(5)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(w.naive)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{fmt(w.seasonal)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(w.sns_organic)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${w.multiplier > 2 ? "text-amber-600 font-medium" : "text-muted-foreground"}`}>{w.multiplier}x</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[9px] ${w.source === "forecast" ? "bg-amber-50 text-amber-700" : ""}`}>
                          {w.source === "forecast" ? "Holiday FC" : "Vel×Seas"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>{result.disclaimer}</span>
          </div>
        </>
      )}
    </div>
  );
}
