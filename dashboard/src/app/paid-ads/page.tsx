"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { isConfigured } from "@/lib/supabase";
import {
  PAID_ADS_ATTRIBUTION,
  PAID_ADS_WINDOWS,
  type ChannelWindowView,
  type PaidAdsChannel,
  type PaidAdsWindowDays,
} from "@/lib/paid-ads";
import { Megaphone, Shield } from "lucide-react";

type Range = PaidAdsWindowDays;

interface PaidAdsResponse {
  attribution?: string;
  channels?: Record<string, { as_of: string | null; windows: ChannelWindowView[] }>;
  migration_needed?: boolean;
  loadErrors?: string[];
  fatalError?: string | null;
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function viewFor(data: PaidAdsResponse | null, channel: PaidAdsChannel, range: Range): ChannelWindowView | null {
  const bundle = data?.channels?.[channel];
  if (!bundle) return null;
  return bundle.windows.find((w) => w.window_days === range) ?? null;
}

function Kpi({
  label, value, hint,
}: {
  label: string; value: string; hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function ChannelSection({
  channel,
  title,
  waitingCopy,
  view,
}: {
  channel: PaidAdsChannel;
  title: string;
  waitingCopy: string;
  view: ChannelWindowView | null;
}) {
  const empty = !view || view.source === "empty";
  const kpis = view?.kpis;
  const campaigns = view?.campaigns ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <Badge variant="outline" className="text-[10px] font-normal">
          {channel}
        </Badge>
        {view?.source && view.source !== "empty" && (
          <span className="text-[10px] text-muted-foreground">
            {view.source === "snapshot" ? "Ads Ops window snapshot" : "rolled from daily rows"}
            {view.as_of ? ` · as of ${view.as_of}` : ""}
            {view.ingested_at ? ` · ingested ${new Date(view.ingested_at).toLocaleString()}` : ""}
          </span>
        )}
      </div>

      {empty ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Megaphone className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{waitingCopy}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              POST a structured payload to <code>/api/paid-ads/ingest</code> — do not scrape Ads Manager.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Kpi
              label={`Spend (${view.window_days}D)`}
              value={`$${fmtD(kpis?.spend ?? 0)}`}
              hint={(kpis?.days_in_window ?? 0) > 0 ? `${kpis!.days_in_window}d with data` : undefined}
            />
            <Kpi label="Conv. value" value={`$${fmt(Math.round(kpis?.sales_or_conv_value ?? 0))}`} />
            <Kpi label="ROAS" value={`${(kpis?.roas ?? 0).toFixed(2)}x`} />
            <Kpi label="CPC" value={`$${fmtD(kpis?.cpc ?? 0)}`} />
            <Kpi label="Clicks" value={fmt(kpis?.clicks ?? 0)} />
            <Kpi label="Impressions" value={fmt(kpis?.impressions ?? 0)} />
            <Kpi label="Conversions" value={fmtD(kpis?.conversions ?? 0)} />
            <Kpi label="Currency" value={view.currency || "USD"} />
          </div>

          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-sm">Top campaigns</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {campaigns.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No campaign rows for this window.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Conv. value</TableHead>
                      <TableHead className="text-right">ROAS</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">Impr.</TableHead>
                      <TableHead className="text-right">CPC</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaigns.map((c) => (
                      <TableRow key={c.campaign_id}>
                        <TableCell>
                          <div className="font-medium">{c.campaign_name}</div>
                          <div className="text-[10px] text-muted-foreground">{c.campaign_id}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(c.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(c.sales_or_conv_value)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.roas.toFixed(2)}x</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(c.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(c.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(c.cpc)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtD(c.conversions)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

export default function PaidAdsPage() {
  const [range, setRange] = useState<Range>(7);
  const [data, setData] = useState<PaidAdsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/paid-ads")
      .then(async (r) => {
        const text = await r.text();
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          throw new Error(r.ok ? "Unexpected non-JSON response" : `HTTP ${r.status}`);
        }
        return JSON.parse(text) as PaidAdsResponse;
      })
      .then((d) => {
        setData(d);
        if (d.fatalError) setError(d.fatalError);
        else if (d.loadErrors?.length) setError(d.loadErrors.join(" · "));
        else setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isConfigured()) {
      setLoading(false);
      return;
    }
    load();
  }, [load]);

  if (!isConfigured()) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Set <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">SUPABASE_SERVICE_KEY</code> so this page
          can read <code className="rounded bg-muted px-1.5 py-0.5 text-xs">paid_ads_*</code> via the server route.
        </p>
      </div>
    );
  }

  if (loading) return <LoadingState />;

  const google = viewFor(data, "google_ads", range);
  const meta = viewFor(data, "meta_ads", range);
  const fatal = Boolean(data?.fatalError) || (Boolean(error) && !data);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Paid Ads (Shopify)</h1>
          <p className="text-sm text-muted-foreground">
            Google Ads now, Meta next — same shape. {PAID_ADS_ATTRIBUTION}
          </p>
        </div>
        <div className="flex gap-1 rounded-md border p-0.5">
          {PAID_ADS_WINDOWS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {r}D
            </button>
          ))}
        </div>
      </div>

      {data?.migration_needed && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          paid_ads_* tables are missing — run <code>supabase/migration_paid_ads.sql</code> in the SQL editor.
        </p>
      )}

      {fatal ? (
        <QueryError message={error} onRetry={load} />
      ) : error ? (
        <Card className="border-amber-500/30">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </CardContent>
        </Card>
      ) : null}

      {!fatal && (
        <>
          <ChannelSection
            channel="google_ads"
            title="Google Ads"
            waitingCopy="No Google Ads data yet. Waiting for an Ads Ops structured payload."
            view={google}
          />
          <ChannelSection
            channel="meta_ads"
            title="Meta Ads"
            waitingCopy="Waiting for Ads Ops Meta payload"
            view={meta}
          />
        </>
      )}
    </div>
  );
}
