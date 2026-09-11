"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { exportBannerFromState, mergeGnoAdsOntoState } from "@/lib/gno-export-state";
import { CM_NOTE } from "@/lib/gno-ppc-watch";
import { OrganicRankHeatmap } from "@/components/organic-rank-heatmap";
import { RT_EMPTY_COPY, formatSoldScopeRank, formatSoldScopeVol } from "@/lib/soldscope-status";
import { OUTLIER_EMPTY_COPY } from "@/lib/soldscope-outliers";
import { COMPETITOR_OUTLIER_EMPTY_COPY } from "@/lib/soldscope-competitor-outliers";
import { AlertTriangle, Check, CheckCircle, Download, RefreshCw, Shield } from "lucide-react";
import {
  gnoAlertKey,
  loadLocalDoneKeys,
  mergeDoneKeys,
  splitDoneAlerts,
  toggleDoneKey,
} from "@/lib/gno-alert-done";

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
  family?: string;
  state: string;
  daily_budget: number | null;
  hours_since_launch: number;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  acos: number | null;
  break_even_acos?: number;
  acos_vs_be?: number | null;
  zero_impr_after_24h: boolean;
  over_shell_budget: boolean;
  last_call?: "hold" | "bid_down" | "bid_up" | null;
}

interface Heartbeat {
  campaign_name: string;
  role: string;
  family?: string;
  state: string;
  enabled: boolean;
  daily_budget: number | null;
  spend_today: number;
  spend_l7_avg: number;
  acos_l7: number | null;
  break_even_acos?: number;
  acos_vs_be?: number | null;
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
  family?: string;
  break_even_acos?: number;
  acos_vs_be?: number | null;
  learning_note?: string;
  soldscope_sv?: number | null;
  soldscope_organic?: number | null;
  soldscope_sponsored?: number | null;
}

interface GnoData {
  observeOnly?: boolean;
  asOf?: string;
  today?: string;
  launchedAt?: string;
  nextReviewAt?: string;
  upcomingReviewAt?: string;
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
  soldscope?: {
    observeOnly?: boolean;
    rankTrackerCopy?: string;
    groups?: number;
    phrases?: number;
    keywordOutliers?: Array<{
      keyword: string;
      asin: string;
      volume: number | null;
      opportunity: number | null;
      already_bidding: "Y" | "N";
      bidding_note: string;
      note: string;
    }>;
    outlierEmptyCopy?: string;
    competitorOutliers?: Array<{
      keyword: string;
      competitor_asin: string;
      our_hero_family: string;
      volume: number | null;
      sfr: number | null;
      opportunity: number | null;
      competitor_organic_rank: number | null;
      competitor_sponsored_rank: number | null;
      our_organic_rank: number | null;
      already_bidding: "Y" | "N";
      suggested_lever: "harvest_exact" | "watch" | "skip";
    }>;
    competitorEmptyCopy?: string;
  };
  lastSync?: { at: string | null; job: string | null; status: string | null };
  exportBanner?: {
    state: "EXPORT_NEEDED" | "QUIET";
    reasons: Array<"P0" | "REVIEW" | "DIGEST">;
    headline: string;
    lastExportAt: string | null;
    lastExportReason: string | null;
    nextReviewAt: string;
    nextReviewLabel: string;
    upcomingReviewAt: string;
    upcomingReviewLabel: string;
    reviewLine: string;
    hoursSinceExport: number | null;
    reviewDue: boolean;
    reviewOverdue: boolean;
    digestWindow: boolean;
  };
  lastExportAt?: string | null;
  lastExportReason?: string | null;
  gaps?: string[];
  acks?: string[];
  lookbackDays?: number;
  loadErrors?: string[];
  error?: string;
}

function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Desk ACOS with family contribution BE — matches pack `acos` / `break_even_acos`. */
function acosWithBe(
  acos: number | null | undefined,
  be?: number | null,
  family?: string,
): string {
  const a = acos == null ? "—" : `${acos.toFixed(0)}%`;
  if (be == null) return a;
  const fam = family && family !== "other" ? ` ${family}` : "";
  return `${a} ·${fam} BE ${be}%`;
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

function AlertRow({
  alert: a,
  done,
  tone,
  onToggle,
}: {
  alert: Alert;
  done: boolean;
  tone: "p0" | "quiet";
  onToggle: (a: Alert, done: boolean) => void;
}) {
  const box = tone === "p0" && !done
    ? "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30"
    : "border-border bg-muted/30";
  return (
    <div className={`flex items-start justify-between gap-2 rounded-md border p-2 text-xs ${box} ${done ? "opacity-60" : ""}`}>
      <div className="min-w-0">
        <p className="font-medium">{a.title}</p>
        <p className="mt-0.5 text-muted-foreground">{a.detail}</p>
      </div>
      <Button
        type="button"
        variant={done ? "default" : "outline"}
        size="sm"
        className="h-7 shrink-0 px-2 text-[10px]"
        onClick={() => onToggle(a, !done)}
      >
        <Check className="mr-1 h-3 w-3" />
        {done ? "Done" : "Mark Done"}
      </Button>
    </div>
  );
}

/**
 * GNO PPC Watch widgets. Own fetch so Recovery / Bleeders on /ppc cannot
 * fail because this panel missed a table. Observe + export + alert only.
 */
export function PpcGnoWatch() {
  const [data, setData] = useState<GnoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adsLoading, setAdsLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sqpNotice, setSqpNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const [sqpBusy, setSqpBusy] = useState(false);
  const [localDone, setLocalDone] = useState<string[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [paste, setPaste] = useState("");
  const [logging, setLogging] = useState(false);

  const load = useCallback(async () => {
    setAdsLoading(true);
    let state: GnoData | null = null;
    try {
      const stateRes = await fetch("/api/ppc/gno-state");
      const stateCt = stateRes.headers.get("content-type") ?? "";
      if (stateCt.includes("application/json")) {
        state = await stateRes.json() as GnoData;
        setData((prev) => mergeGnoAdsOntoState(prev, state as GnoData));
        setLoading(false);
      }
    } catch { /* ads path still runs; banner stays conservative */ }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch("/api/ppc/gno", { signal: ctrl.signal });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Unexpected ${res.status} response from /api/ppc/gno.`);
      }
      const d = await res.json() as GnoData;
      setData(mergeGnoAdsOntoState(state, d));
      setError(d.error ?? null);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setError(aborted
        ? "Campaign tiles timed out. Export state is still on the banner — pack remains downloadable."
        : (e instanceof Error ? e.message : "Could not load GNO Watch."));
    } finally {
      clearTimeout(timer);
      setLoading(false);
      setAdsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setLocalDone(loadLocalDoneKeys()); }, []);

  const doneKeys = mergeDoneKeys(localDone, data?.acks);

  function markDone(a: Alert, done: boolean) {
    const key = gnoAlertKey(a);
    setLocalDone(toggleDoneKey(localDone, key, done));
    void fetch("/api/ppc/gno-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        code: a.code,
        campaign_name: a.campaign_name,
        search_term: a.search_term,
        priority: a.priority,
        done,
      }),
    }).catch(() => { /* localStorage already holds the checkoff */ });
  }

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
      await load();
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

  async function logOutcomes(payload: {
    paste?: string;
    entries?: Array<{
      dave_action: string;
      campaign_name?: string;
      search_term?: string;
      proposed_tag?: string;
    }>;
  }) {
    setLogging(true);
    setNotice(null);
    try {
      const res = await fetch("/api/ppc/gno-outcome", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json() as { ok?: boolean; written?: number; error?: string; hint?: string };
      if (!res.ok || d.ok === false) {
        setNotice(d.error ?? d.hint ?? "Could not log outcome.");
        return;
      }
      setNotice(`Logged ${d.written ?? 0} outcome(s). Observe only — nothing wrote to Amazon.`);
      if (payload.paste) setPaste("");
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not log outcome.");
    } finally {
      setLogging(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading GNO PPC Watch…</p>;
  }

  const p0All = data?.p0 ?? [];
  const { open: p0, done: p0Done } = splitDoneAlerts(p0All, doneKeys);
  const p1All = (data?.p1 ?? []).filter((a) =>
    ["JUNK_CANDIDATE", "PP_SHARE", "NEW_EXACT_DIGEST", "HARVEST_CANDIDATE"].includes(a.code));
  const { open: p1Open, done: p1Done } = splitDoneAlerts(p1All, doneKeys);
  const lookbackNotes = splitDoneAlerts(
    (data?.p2 ?? []).filter((a) => a.code === "KEEPER_MISSING"),
    doneKeys,
  );
  const tiles = data?.newExact ?? [];
  const keepers = data?.keepers ?? [];
  const harvest = data?.harvestQueue ?? [];
  const doneCount = p0Done.length + p1Done.length + lookbackNotes.done.length;
  const banner = data?.exportBanner ?? exportBannerFromState({
    last_export_at: data?.lastExportAt,
    last_export_reason: data?.lastExportReason,
  }, {
    p0: data?.p0 ?? [],
    p1: data?.p1 ?? [],
  });
  const exportDue = banner.state === "EXPORT_NEEDED";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">GNO PPC Watch</h1>
          <p className="text-sm text-muted-foreground">
            Tallowbourn US · observe + export + alert only · closed LA day {data?.asOf ?? "—"}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Campaign L2 = spend source of truth. Search-term files = negate / harvest.
            Family BE ACOS is the config contribution-margin target ({CM_NOTE}).
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

      <div
        role="status"
        data-export-state={banner.state}
        className={`rounded-lg border p-3 text-sm ${
          exportDue
            ? "border-amber-500/60 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
            : "border-emerald-400/40 bg-emerald-50/70 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100"
        }`}
      >
        <p className="flex items-center gap-2 font-semibold">
          {exportDue
            ? <AlertTriangle className="h-4 w-4 shrink-0" />
            : <CheckCircle className="h-4 w-4 shrink-0" />}
          {exportDue ? "EXPORT NEEDED" : "Up to date"}
        </p>
        <p className="mt-1 text-xs">
          {banner.headline}
          {banner.reasons.length ? ` · ${banner.reasons.join(" + ")}` : ""}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {banner.reviewLine}
          {banner.lastExportReason ? ` · last export reason ${banner.lastExportReason}` : ""}
          {" · "}<Link href="/ppc" className="underline">Back to Recovery / This week</Link>
        </p>
      </div>

      <div
        data-gno-region="howto"
        className="rounded-lg border bg-muted/30 p-3 text-[11px] text-foreground"
      >
        <p className="font-semibold">When to Export GNO pack</p>
        <ol className="mt-1.5 list-decimal space-y-1 pl-4">
          <li><strong>Anytime a P0 fires</strong> — download the zip, drop it in Grok immediately.</li>
          <li>
            <strong>Every Wednesday evening ~48h review</strong>
            {" "}(6:00 PM PT — this Wed / next Wed).
            {banner.reviewOverdue
              ? ` This week's pass is overdue. Next scheduled after export: ${banner.upcomingReviewLabel}.`
              : ` Next scheduled: ${banner.upcomingReviewLabel}.`}
            {" "}Export even if quiet — that is the hold / bid / harvest pass.
          </li>
          <li>
            <strong>Optional Mon/Wed/Fri morning digest</strong>
            {" "}for Auto Loose P1s (06:30–08:00 ET). Otherwise watch the page alerts.
          </li>
        </ol>
        <p className="mt-2 text-muted-foreground">
          Observe only — export never writes to Amazon. One change per campaign per day still Dave/Grok.
        </p>
      </div>

      {error && (
        <Card className={banner.lastExportAt
          ? "border-border"
          : "border-red-200 dark:border-red-900"}>
          <CardContent className={`py-4 text-sm ${banner.lastExportAt
            ? "text-muted-foreground"
            : "text-red-700 dark:text-red-300"}`}>
            {error}
            {banner.lastExportAt && (
              <p className="mt-1 text-xs">
                Last export is on the banner. Export GNO pack still works.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {adsLoading && (
        <p className="text-xs text-muted-foreground">Loading campaign tiles…</p>
      )}

      {notice && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs">{notice}</p>
      )}

      {(p0.length > 0 || (showDone && p0Done.length > 0)) && (
        <Card className="border-red-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-sm text-red-700 dark:text-red-300">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> P0 — ping Dave
              </span>
              {p0Done.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-[10px]"
                  onClick={() => setShowDone((v) => !v)}>
                  {showDone ? "Hide done" : `Show ${p0Done.length} done`}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {p0.map((a) => (
              <AlertRow key={gnoAlertKey(a)} alert={a} done={false} tone="p0" onToggle={markDone} />
            ))}
            {showDone && p0Done.map((a) => (
              <AlertRow key={gnoAlertKey(a)} alert={a} done tone="p0" onToggle={markDone} />
            ))}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-1 text-sm font-semibold">New Exact — campaign L2 spend is SoT</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Today is config-only. Read spend / ACOS from closed L2 (and L7), not from search-term files.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {tiles.length === 0 && (
            <p className="col-span-full text-xs text-muted-foreground">
              {adsLoading
                ? "Loading New Exact tiles…"
                : "No New Exact tiles in this payload. Export still works. Spend is never invented."}
            </p>
          )}
          {tiles.map((t) => (
            <Card key={t.campaign_name} className={t.zero_impr_after_24h ? "border-red-500/60" : ""}>
              <CardContent className="space-y-1 p-3">
                <p className="truncate text-[10px] font-medium" title={t.campaign_name}>{t.keyword || t.campaign_name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{t.campaign_name.split("|").pop()?.trim()}</p>
                <p className="text-xs tabular-nums">Impr {t.impressions.toLocaleString()}</p>
                <p className="text-xs tabular-nums">Spend ${money(t.spend)}</p>
                <p className="text-xs tabular-nums">Orders {t.orders}</p>
                <p className="text-xs tabular-nums">ACOS {acosWithBe(t.acos, t.break_even_acos, t.family)}</p>
                <p className="text-[10px] text-muted-foreground">{t.hours_since_launch.toFixed(0)}h since launch</p>
                {t.last_call && (
                  <p className="text-[10px] font-medium">last call: {t.last_call.replace("_", " ")}</p>
                )}
                {t.zero_impr_after_24h && (
                  <Badge variant="outline" className="text-[9px] text-red-700 border-red-300">0 impr after 24h</Badge>
                )}
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {(["hold", "bid_down", "bid_up"] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      disabled={logging}
                      onClick={() => logOutcomes({
                        entries: [{
                          dave_action: action,
                          campaign_name: t.campaign_name,
                          proposed_tag: "NEW_EXACT",
                        }],
                      })}
                      className="rounded border px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-muted"
                    >
                      {action.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-sm font-semibold">Keepers — campaign L2 spend heartbeat</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Campaign L2 / L7 spend is the source of truth. Missing $0 days in Ads reports are not a pause.
        </p>
        <div className="grid gap-2 md:grid-cols-3">
          {keepers.length === 0 && (
            <p className="col-span-full text-xs text-muted-foreground">
              {adsLoading
                ? "Loading keeper heartbeats…"
                : "No keeper rows in this payload. Confirm in Ads console if needed. Observe only."}
            </p>
          )}
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
                <p className="text-xs tabular-nums">L7 ACOS {acosWithBe(k.acos_l7, k.break_even_acos, k.family)}</p>
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
          <CardTitle className="text-sm">Harvest / junk — search-term files (negate / harvest)</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            ST files drive term negate / harvest. Campaign L2 is spend SoT — do not mix them.
            Clicking a row does <strong>not</strong> negate. It adds the term to
            the next Grok pack selection ({queued.length} queued). Tags only.
            Log Grok outcome stores Dave&apos;s call — still no Amazon write.
            SS Vol / Org / Sp light up from SoldScope when stored; em dash means empty, not zero.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Search term</TableHead>
                <TableHead className="text-right">SS Vol</TableHead>
                <TableHead className="text-right">Org</TableHead>
                <TableHead className="text-right">Sp</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">ACOS vs BE</TableHead>
                <TableHead>Exact home</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead>Log Grok outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {harvest.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-xs text-muted-foreground">
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
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground" title="SoldScope search volume when stored">
                      {formatSoldScopeVol(t.soldscope_sv)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground" title="SoldScope organic rank when a Rank Tracker group exists">
                      {formatSoldScopeRank(t.soldscope_organic)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground" title="SoldScope sponsored rank when a Rank Tracker group exists">
                      {formatSoldScopeRank(t.soldscope_sponsored)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">${money(t.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{t.orders}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{acosWithBe(t.acos, t.break_even_acos, t.family)}</TableCell>
                    <TableCell className="text-xs">{t.has_enabled_exact_elsewhere ? "yes" : "no"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[9px]">{on ? "IN PACK" : t.proposed_tag}</Badge>
                      {t.learning_note && (
                        <p className="mt-0.5 text-[9px] text-muted-foreground">{t.learning_note}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          disabled={logging}
                          onClick={(e) => {
                            e.stopPropagation();
                            logOutcomes({
                              entries: [{
                                dave_action: "skip",
                                campaign_name: t.campaign_name,
                                search_term: t.customer_search_term,
                                proposed_tag: t.proposed_tag,
                              }],
                            });
                          }}
                          className="rounded border px-1.5 py-0.5 text-[9px] hover:bg-muted"
                        >
                          Skip
                        </button>
                        <button
                          type="button"
                          disabled={logging}
                          onClick={(e) => {
                            e.stopPropagation();
                            logOutcomes({
                              entries: [{
                                dave_action: "approve_harvest_neg",
                                campaign_name: t.campaign_name,
                                search_term: t.customer_search_term,
                                proposed_tag: t.proposed_tag,
                              }],
                            });
                          }}
                          className="rounded border px-1.5 py-0.5 text-[9px] hover:bg-muted"
                        >
                          Approve neg
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="space-y-2 border-t p-3">
            <p className="text-[11px] font-medium">Log Grok outcome</p>
            <p className="text-[11px] text-foreground/80">
              Paste one line per call. Must not auto-negate.
              Examples: <code>tallow lip balm organic skip</code>,
              {" "}<code>cheap chapstick approve_harvest_neg</code>,
              {" "}<code>hold SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS</code>
            </p>
            <Textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={3}
              placeholder="one outcome per line"
              className="text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={logging || !paste.trim()}
              onClick={() => logOutcomes({ paste })}
            >
              {logging ? "Saving…" : "Save outcomes"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {(p1Open.length > 0 || (showDone && p1Done.length > 0)) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              <span>Mon/Wed/Fri morning digest — Auto Loose P1s</span>
              {doneCount > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-[10px]"
                  onClick={() => setShowDone((v) => !v)}>
                  {showDone ? "Hide done" : `Show ${doneCount} done`}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {p1Open.slice(0, 16).map((a) => (
              <AlertRow key={gnoAlertKey(a)} alert={a} done={false} tone="quiet" onToggle={markDone} />
            ))}
            {showDone && p1Done.map((a) => (
              <AlertRow key={gnoAlertKey(a)} alert={a} done tone="quiet" onToggle={markDone} />
            ))}
          </CardContent>
        </Card>
      )}

      {lookbackNotes.open.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">KEEP-ALIVE not in this spend window</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              The desk reads {data?.lookbackDays ?? 14} closed days. Ads reports omit $0 days,
              so a missing keeper is <strong>not a P0</strong>. Confirm in Ads console if needed.
              Observe only.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {lookbackNotes.open.map((a) => (
              <AlertRow key={gnoAlertKey(a)} alert={a} done={false} tone="quiet" onToggle={markDone} />
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] font-medium text-muted-foreground">Supporting intel</p>
      <OrganicRankHeatmap />

      <Card id="soldscope-outliers">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">SoldScope keyword outliers — bid-base checklist</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            High-opportunity phrases vs current Exact/Phrase/Broad targets and Auto Loose / Fat parent
            search terms. Tags only — nothing writes to Amazon. Empty until stored Rank Tracker phrases
            or a saved Keyword Research search land. This desk does not create SoldScope RT groups.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Keyword</TableHead>
                <TableHead>ASIN</TableHead>
                <TableHead className="text-right">Vol</TableHead>
                <TableHead className="text-right">Opp</TableHead>
                <TableHead>Bidding</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.soldscope?.keywordOutliers ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-xs text-muted-foreground">
                    {data?.soldscope?.outlierEmptyCopy ?? OUTLIER_EMPTY_COPY}
                  </TableCell>
                </TableRow>
              )}
              {(data?.soldscope?.keywordOutliers ?? []).map((row) => (
                <TableRow key={`${row.asin}-${row.keyword}`}>
                  <TableCell className="text-xs">{row.keyword}</TableCell>
                  <TableCell className="text-[10px] tabular-nums text-muted-foreground">{row.asin}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatSoldScopeVol(row.volume)}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatSoldScopeVol(row.opportunity)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[9px]">
                      {row.already_bidding}
                    </Badge>
                    {row.bidding_note && row.bidding_note !== "—" && (
                      <p className="mt-0.5 text-[9px] text-muted-foreground">{row.bidding_note}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-[10px] text-muted-foreground">{row.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card id="competitor-kr-outliers">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Competitor reverse-ASIN keywords — recommend only</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Keywords competitor ASINs rank or bid on, joined to our Exact{" "}
            <code>keyword_targets</code>. Lever is harvest_exact / watch / skip —
            nothing writes to Amazon. Weekly SoldScope reuse of saved searchType0 KR.
            First fill is CLI <code>--create-missing</code> (cap 5/run). Empty until
            snapshots land.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Keyword</TableHead>
                <TableHead>Competitor</TableHead>
                <TableHead>Family</TableHead>
                <TableHead className="text-right">Vol / SFR / Opp</TableHead>
                <TableHead className="text-right">Comp org / sp</TableHead>
                <TableHead className="text-right">Our org</TableHead>
                <TableHead>Exact</TableHead>
                <TableHead>Lever</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.soldscope?.competitorOutliers ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-xs text-muted-foreground">
                    {data?.soldscope?.competitorEmptyCopy ?? COMPETITOR_OUTLIER_EMPTY_COPY}
                  </TableCell>
                </TableRow>
              )}
              {(data?.soldscope?.competitorOutliers ?? []).map((row) => (
                <TableRow key={`${row.competitor_asin}-${row.keyword}`}>
                  <TableCell className="text-xs">{row.keyword}</TableCell>
                  <TableCell className="text-[10px] tabular-nums text-muted-foreground">
                    {row.competitor_asin}
                  </TableCell>
                  <TableCell className="text-[10px]">{row.our_hero_family}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {formatSoldScopeVol(row.volume)}
                    {" / "}
                    {formatSoldScopeVol(row.sfr)}
                    {" / "}
                    {formatSoldScopeVol(row.opportunity)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {formatSoldScopeRank(row.competitor_organic_rank)}
                    {" / "}
                    {formatSoldScopeRank(row.competitor_sponsored_rank)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {formatSoldScopeRank(row.our_organic_rank)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[9px]">
                      {row.already_bidding}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[9px]">
                      {row.suggested_lever}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
            {" "}{data?.soldscope?.rankTrackerCopy ?? RT_EMPTY_COPY}
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
