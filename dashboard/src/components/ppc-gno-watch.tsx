"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Download, RefreshCw, Shield } from "lucide-react";

interface Alert {
  priority: "P0" | "P1" | "P2";
  code: string;
  title: string;
  detail: string;
  campaign_name?: string;
  search_term?: string;
  auto_action: false;
}

interface Tile {
  campaign_name: string;
  keyword: string;
  state: string;
  daily_budget: number | null;
  hours_since_launch: number;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  acos: number | null;
  zero_impr_after_24h: boolean;
  over_shell_budget: boolean;
}

interface Heartbeat {
  campaign_name: string;
  role: string;
  state: string;
  enabled: boolean;
  daily_budget: number | null;
  spend_today: number;
  spend_l7_avg: number;
  acos_l7: number | null;
  sparkline: number[];
}

interface HarvestRow {
  campaign_name: string;
  customer_search_term: string;
  match_type: string;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  acos: number | null;
  cvr: number | null;
  has_enabled_exact_elsewhere: boolean;
  proposed_tag: string;
}

interface GnoData {
  observeOnly?: boolean;
  asOf?: string;
  today?: string;
  launchedAt?: string;
  nextReviewAt?: string;
  hoursSinceLaunch?: number;
  p0?: Alert[];
  p1?: Alert[];
  p2?: Alert[];
  newExact?: Tile[];
  keepers?: Heartbeat[];
  harvestQueue?: HarvestRow[];
  junkQueue?: HarvestRow[];
  sbL7?: Array<{ campaign_name: string; spend: number; sales: number; orders: number; acos: number | null }>;
  sqp?: { available: boolean; newestAsOf: string | null; stale: boolean; source?: string | null };
  lastSync?: { at: string | null; job: string | null; status: string | null };
  gaps?: string[];
  loadErrors?: string[];
  error?: string;
}

function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Spark({ values }: { values: number[] }) {
  if (!values.length) return <span className="text-[10px] text-muted-foreground">—</span>;
  const w = 84, h = 22, pad = 1;
  const max = Math.max(...values, 0.01);
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / Math.max(values.length - 1, 1);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={w} height={h} className="block" aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} />
    </svg>
  );
}

const ROLE_LABEL: Record<string, string> = {
  auto_loose: "Auto Loose TOS",
  fat_parent: "Fat parent",
  hero_chapstick: "Hero chapstick",
};

/**
 * GNO PPC Watch widgets. Own fetch so Recovery / Bleeders on /ppc cannot
 * fail because this panel missed a table. Observe + export + alert only.
 */
export function PpcGnoWatch() {
  const [data, setData] = useState<GnoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sqpNotice, setSqpNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const [sqpBusy, setSqpBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ppc/gno");
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Unexpected ${res.status} response from /api/ppc/gno.`);
      }
      const d = await res.json() as GnoData;
      setData(d);
      setError(d.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load GNO Watch.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function exportPack() {
    setExporting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/ppc/gno-export");
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.includes("zip")) {
        const d = ct.includes("json") ? await res.json() : null;
        setNotice(d?.hint ?? d?.error ?? `Export failed (${res.status}).`);
        return;
      }
      const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      const name = match?.[1] ?? "gno-pack.zip";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name} — observe only. Drop it in Grok. Nothing writes to Amazon.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function uploadSqp(file: File) {
    setSqpBusy(true);
    setSqpNotice(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/ppc/gno-sqp", { method: "POST", body });
      const ct = res.headers.get("content-type") ?? "";
      const d = ct.includes("json") ? await res.json() : {};
      if (!res.ok || d.ok === false) {
        setSqpNotice({
          ok: false,
          text: d.error ?? d.hint ?? "SQP upload failed. Shares are never invented.",
        });
        return;
      }
      const week = d.week_end ? `week ending ${d.week_end}` : "week unknown";
      const weeklyN = d.sqpWeeklyWritten ?? 0;
      const rankN = d.keywordRankWritten ?? 0;
      setSqpNotice({
        ok: true,
        text: `Stored ${week}: ${weeklyN} sqp_weekly row(s), ${rankN} keyword rank row(s).`,
      });
      await load();
    } catch (e) {
      setSqpNotice({
        ok: false,
        text: e instanceof Error ? e.message : "SQP upload failed.",
      });
    } finally {
      setSqpBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading GNO PPC Watch…</p>;
  }
  if (error && !data?.newExact?.length) {
    return (
      <Card className="border-red-200 dark:border-red-900">
        <CardContent className="py-6 text-sm text-red-700 dark:text-red-300">
          {error}
        </CardContent>
      </Card>
    );
  }

  const p0 = data?.p0 ?? [];
  const tiles = data?.newExact ?? [];
  const keepers = data?.keepers ?? [];
  const harvest = data?.harvestQueue ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">GNO PPC Watch</h1>
          <p className="text-sm text-muted-foreground">
            Tallowbourn US · observe + export + alert only · closed LA day {data?.asOf ?? "—"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); load(); }}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
          <Button size="sm" onClick={exportPack} disabled={exporting}>
            <Download className="mr-1 h-3 w-3" />
            {exporting ? "Building…" : "Export GNO pack"}
          </Button>
        </div>
      </div>

      <p className="rounded-lg border border-amber-500/40 bg-amber-50 p-2.5 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Observe only.</strong> This desk never pauses, never adds negatives,
        never raises bids or budgets. Harvest clicks queue the next Grok pack.
        Next human review: {data?.nextReviewAt ?? "Wed 9 Sep evening"}.
        {" "}<Link href="/ppc" className="underline">Back to Recovery / This week</Link>
      </p>

      {notice && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs">{notice}</p>
      )}

      {p0.length > 0 && (
        <Card className="border-red-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> P0 — ping Dave
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {p0.map((a, i) => (
              <div key={`${a.code}-${i}`} className="rounded-md border border-red-200 bg-red-50/60 p-2 text-xs dark:border-red-900 dark:bg-red-950/30">
                <p className="font-medium">{a.title}</p>
                <p className="mt-0.5 text-muted-foreground">{a.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold">New Exact strip</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {tiles.map((t) => (
            <Card key={t.campaign_name} className={t.zero_impr_after_24h ? "border-red-500/60" : ""}>
              <CardContent className="space-y-1 p-3">
                <p className="truncate text-[10px] font-medium" title={t.campaign_name}>{t.keyword || t.campaign_name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{t.campaign_name.split("|").pop()?.trim()}</p>
                <p className="text-xs tabular-nums">Impr {t.impressions.toLocaleString()}</p>
                <p className="text-xs tabular-nums">Spend ${money(t.spend)}</p>
                <p className="text-xs tabular-nums">Orders {t.orders}</p>
                <p className="text-xs tabular-nums">ACOS {t.acos == null ? "—" : `${t.acos.toFixed(0)}%`}</p>
                <p className="text-[10px] text-muted-foreground">{t.hours_since_launch.toFixed(0)}h since launch</p>
                {t.zero_impr_after_24h && (
                  <Badge variant="outline" className="text-[9px] text-red-700 border-red-300">0 impr after 24h</Badge>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Keeper heartbeat</h2>
        <div className="grid gap-2 md:grid-cols-3">
          {keepers.map((k) => (
            <Card key={k.role} className={k.enabled ? "border-emerald-400/50" : "border-red-500/60"}>
              <CardContent className="space-y-1.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{ROLE_LABEL[k.role] ?? k.role}</p>
                  <Badge variant="outline" className={k.enabled
                    ? "text-[9px] text-emerald-700 border-emerald-300"
                    : "text-[9px] text-red-700 border-red-300"}>
                    {k.enabled ? "Enabled" : (k.state || "unknown")}
                  </Badge>
                </div>
                <p className="truncate text-[10px] text-muted-foreground" title={k.campaign_name}>{k.campaign_name}</p>
                <p className="text-xs tabular-nums">As-of ${money(k.spend_today)} · L7 avg ${money(k.spend_l7_avg)}</p>
                <p className="text-xs tabular-nums">L7 ACOS {k.acos_l7 == null ? "—" : `${k.acos_l7.toFixed(0)}%`}</p>
                <div className={k.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}>
                  <Spark values={k.sparkline} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Harvest queue — Auto Loose</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Clicking a row does <strong>not</strong> negate. It adds the term to
            the next Grok pack selection ({queued.length} queued). Tags only.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Search term</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">ACOS</TableHead>
                <TableHead>Exact home</TableHead>
                <TableHead>Tag</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {harvest.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-xs text-muted-foreground">
                    No HARVEST_CANDIDATE terms on Auto Loose for L7.
                  </TableCell>
                </TableRow>
              )}
              {harvest.map((t) => {
                const on = queued.includes(t.customer_search_term);
                return (
                  <TableRow
                    key={t.customer_search_term}
                    className={`cursor-pointer ${on ? "bg-emerald-50/70 dark:bg-emerald-950/30" : ""}`}
                    onClick={() => setQueued((q) =>
                      q.includes(t.customer_search_term)
                        ? q.filter((x) => x !== t.customer_search_term)
                        : [...q, t.customer_search_term])}
                  >
                    <TableCell className="text-xs">{t.customer_search_term}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">${money(t.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{t.orders}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{t.acos == null ? "—" : `${t.acos.toFixed(0)}%`}</TableCell>
                    <TableCell className="text-xs">{t.has_enabled_exact_elsewhere ? "yes" : "no"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[9px]">{on ? "IN PACK" : t.proposed_tag}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(data?.p1 ?? []).filter((a) => a.code === "JUNK_CANDIDATE" || a.code === "PP_SHARE").length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">P1 digest (flag only)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {(data?.p1 ?? []).filter((a) => ["JUNK_CANDIDATE", "PP_SHARE", "NEW_EXACT_DIGEST"].includes(a.code)).slice(0, 16).map((a, i) => (
              <p key={`${a.code}-${i}`} className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{a.title}.</span> {a.detail}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {!!data?.sbL7?.length && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">SB L7 (read-only)</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              We are not touching SB this week. Watch for a dead SB hole that SP harvest would fight.
            </p>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.sbL7.map((r) => (
              <p key={r.campaign_name} className="truncate text-xs tabular-nums">
                {r.campaign_name} · ${money(r.spend)} · ACOS {r.acos == null ? "—" : `${r.acos.toFixed(0)}%`}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Shield className="h-4 w-4" /> SQP Brand Analytics — manual upload
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Brand Analytics is not in the Ads API. Drop the official SQP CSV.
            Impression / purchase share is never invented.
            {data?.sqp?.newestAsOf
              ? ` Newest stored week: ${data.sqp.newestAsOf}.`
              : " No SQP rows stored."}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={sqpBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadSqp(f);
                e.target.value = "";
              }}
              className="text-xs"
            />
            {sqpBusy && (
              <span className="text-xs text-muted-foreground">Uploading…</span>
            )}
            {sqpNotice && (
              <span
                role="status"
                className={`rounded-md border px-2.5 py-1.5 text-xs ${
                  sqpNotice.ok
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                    : "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                }`}
              >
                {sqpNotice.text}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {!!data?.gaps?.length && (
        <p className="text-[10px] text-muted-foreground">
          Gaps (not faked): {data.gaps.join(" · ")}
          {data.lastSync?.at ? ` · Last ads job ${data.lastSync.job} ${data.lastSync.status}` : ""}
          {(data.loadErrors ?? []).length ? ` · ${data.loadErrors?.join(" · ")}` : ""}
        </p>
      )}
    </div>
  );
}
