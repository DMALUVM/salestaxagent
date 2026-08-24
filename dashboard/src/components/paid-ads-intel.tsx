"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { SectionNav } from "@/components/section-nav";
import type {
  IntelBundle, IntelCard, IntelFilter, IntelRangeDays, PlatformKpis,
} from "@/lib/paid-intel/types";
import { INTEL_FILTERS, INTEL_RANGES } from "@/lib/paid-intel/types";
import {
  ClipboardCopy, Download, Megaphone, Upload, AlertTriangle, CheckCircle2,
} from "lucide-react";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money(n: number) {
  return `$${fmtD(n)}`;
}

const SEV: Record<IntelCard["severity"], string> = {
  critical: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900",
  warn: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  info: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

const ACTION: Record<IntelCard["action"], string> = {
  kill: "KILL",
  keep: "KEEP",
  shift: "SHIFT",
  fix: "FIX",
};

const LEFT_BORDER: Record<IntelCard["severity"], string> = {
  critical: "#dc2626",
  warn: "#d97706",
  info: "#64748b",
};

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function DualChart({ daily }: { daily: IntelBundle["daily"] }) {
  const max = Math.max(
    1,
    ...daily.flatMap((d) => [d.google_spend, d.google_revenue, d.meta_spend, d.meta_revenue]),
  );
  const shown = daily.slice(-30);
  if (!shown.length) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-500" /> Google spend</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-blue-200 dark:bg-blue-300" /> Google conv. value</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-violet-500" /> Meta spend</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-violet-200 dark:bg-violet-300" /> Meta purchases value</span>
      </div>
      <div className="flex h-36 items-end gap-px overflow-x-auto" role="img" aria-label="Daily Google and Meta spend versus conversion value">
        {shown.map((d) => (
          <div
            key={d.date}
            className="flex min-w-[10px] flex-1 items-end gap-px"
            title={`${d.date} · G ${money(d.google_spend)} / ${money(d.google_revenue)} · M ${money(d.meta_spend)} / ${money(d.meta_revenue)}`}
          >
            <div className="w-1/4 bg-blue-500" style={{ height: `${(d.google_spend / max) * 100}%` }} />
            <div className="w-1/4 bg-blue-200 dark:bg-blue-300" style={{ height: `${(d.google_revenue / max) * 100}%` }} />
            <div className="w-1/4 bg-violet-500" style={{ height: `${(d.meta_spend / max) * 100}%` }} />
            <div className="w-1/4 bg-violet-200 dark:bg-violet-300" style={{ height: `${(d.meta_revenue / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{shown[0]?.date}</span>
        <span>{shown[shown.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function ChartSpark({ chart }: { chart: IntelBundle["gsc"]["chart"] }) {
  const pts = chart.filter((r) => r.date).slice(-30);
  if (pts.length < 2) return null;
  const max = Math.max(1, ...pts.map((p) => p.clicks));
  return (
    <div className="flex h-16 items-end gap-px" aria-label="GSC daily organic clicks">
      {pts.map((p) => (
        <div
          key={p.date}
          className="flex-1 bg-emerald-500/70"
          style={{ height: `${(p.clicks / max) * 100}%` }}
          title={`${p.date} · ${p.clicks} clicks`}
        />
      ))}
    </div>
  );
}

function IntelCardView({ card, index }: { card: IntelCard; index: number }) {
  return (
    <Card className="border-l-4" style={{ borderLeftColor: LEFT_BORDER[card.severity] }}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
          <Badge variant="outline" className={SEV[card.severity]}>{card.severity}</Badge>
          <Badge variant="outline">{card.owner === "site" ? "SITE" : "ADS"}</Badge>
          <Badge variant="outline">{ACTION[card.action]}</Badge>
          <span className="text-[10px] tabular-nums text-muted-foreground">{money(card.stake)} at stake</span>
          <span className="text-[10px] text-muted-foreground">{card.metric}</span>
        </div>
        <h3 className="text-sm font-semibold leading-snug">{card.title}</h3>
        <p className="text-[13px] text-muted-foreground">{card.body}</p>
        <div className="grid gap-2 text-[12px] sm:grid-cols-2">
          <p><span className="font-medium text-foreground">Do this · 7 days. </span>{card.doThis}</p>
          <p><span className="font-medium text-foreground">If it works. </span>{card.ifItWorks}</p>
        </div>
        <p className="text-[11px] text-muted-foreground">Evidence — {card.evidence}</p>
      </CardContent>
    </Card>
  );
}

function platLabel(k: PlatformKpis) {
  return k.days ? `${k.days}d in file` : "no rows";
}

function roasHint(k: PlatformKpis) {
  return k.spend > 0 ? `${k.roas.toFixed(2)}x ROAS` : "no spend";
}

function pctDelta(curr: number, prev: number): string {
  if (!prev) return "—";
  const d = ((curr - prev) / prev) * 100;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(0)}%`;
}

const EMPTY_BRIEF = { headline: "", ads: "", site: "" };

export function PaidAdsIntel({
  data,
  range,
  filter,
  onRange,
  onFilter,
  onUploaded,
}: {
  data: IntelBundle;
  range: IntelRangeDays;
  filter: IntelFilter;
  onRange: (r: IntelRangeDays) => void;
  onFilter: (f: IntelFilter) => void;
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drag, setDrag] = useState(false);

  const empty = !data.as_of;

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f, f.name);
      const res = await fetch("/api/paid-ads/csv", { method: "POST", body: fd });
      const json = await res.json() as {
        ok?: boolean; error?: string; upserted?: Record<string, number>;
        sources?: string[]; warnings?: string[];
      };
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const u = json.upserted ?? {};
      setMsg(`Upserted ${u.campaigns ?? 0} campaign days, ${u.queries ?? 0} GSC rows, ${u.ga ?? 0} GA4 rows${json.sources?.length ? ` · ${json.sources.join(", ")}` : ""}.`);
      onUploaded();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function copyGrok() {
    const text = data.grok?.markdown ?? "";
    if (!text) {
      setMsg("Nothing to copy yet.");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Clipboard blocked — use the .md download.");
    }
  }

  function downloadGrok() {
    const blob = new Blob([data.grok?.markdown ?? ""], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tallowbourn-ads-intel-${data.as_of ?? "empty"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const g = data.kpis.google;
  const m = data.kpis.meta;
  const b = data.kpis.blended;
  const wow = data.wow ?? { last: b, prior: b };
  const brief = data.brief ?? EMPTY_BRIEF;
  const googleWins = g.spend >= 1 && m.spend >= 1 && g.roas > m.roas;
  const metaWins = g.spend >= 1 && m.spend >= 1 && m.roas > g.roas;

  const sections = empty
    ? []
    : [
        { id: "command", label: "Command" },
        { id: "intel", label: "This week" },
        { id: "ads-desk", label: "Ads lead" },
        { id: "site-desk", label: "Web team" },
        { id: "campaigns", label: "Campaigns" },
        ...(data.gsc.hidden ? [] : [{ id: "gsc", label: "Search" }]),
        { id: "ga4", label: "GA4" },
      ];

  return (
    <div
      className="space-y-6"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      {drag && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/70 text-sm font-medium">
          Drop Google / Meta / GSC / GA4 CSVs
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Paid Ads (Shopify)</h1>
          <p className="text-sm text-muted-foreground">
            Tallowbourn ads Intel from your CSVs — Google, Meta, GSC, GA4. No OAuth.
            Range is relative to the newest date <em>in the files</em>
            {data.as_of ? ` (${data.as_of})` : ""}, not today.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {busy ? "Reading…" : "Upload CSVs"}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.zip,text/csv,application/zip"
            className="hidden"
            aria-label="Upload Google, Meta, GSC, or GA4 CSVs"
            onChange={(e) => onFiles(e.target.files)}
          />
          <Button variant="outline" size="sm" onClick={copyGrok} disabled={empty}>
            <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy for Grok"}
          </Button>
          <Button variant="outline" size="sm" onClick={downloadGrok} disabled={empty}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            .md
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border p-0.5" role="group" aria-label="Date range">
          {INTEL_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => onRange(r)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {r === 0 ? "All" : `${r}D`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-md border p-0.5" role="group" aria-label="Platform filter">
          {INTEL_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => onFilter(f)}
              className={`rounded px-2.5 py-1 text-xs capitalize transition-colors ${
                filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {msg && (
        <p className="text-xs text-muted-foreground">{msg}</p>
      )}

      {empty ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Megaphone className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Drop Google Ads Daily, Meta campaign export, GSC (Queries + Chart + Pages), and a GA4 Explore CSV.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              A missing source omits that channel — it does not crash. Matching days overwrite; older days stay.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionNav items={sections} />

          <section id="command" className="space-y-3 scroll-mt-12">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Command</h2>
              <span className="text-[10px] text-muted-foreground">Google vs Meta · ads conversion value, not GA4 revenue</span>
            </div>
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <Kpi label="Google spend" value={money(g.spend)} hint={`${roasHint(g)} · ${platLabel(g)}${googleWins ? " · winner" : ""}`} />
              <Kpi label="Google conv. value" value={money(g.conv_value)} hint={roasHint(g)} />
              <Kpi label="Meta spend" value={money(m.spend)} hint={`${roasHint(m)} · ${platLabel(m)}${metaWins ? " · winner" : ""}`} />
              <Kpi label="Meta purchase value" value={money(m.conv_value)} hint={roasHint(m)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi
                label="Blended ads ROAS"
                value={b.spend > 0 ? `${b.roas.toFixed(2)}x` : "—"}
                hint={`${money(b.spend)} in / ${money(b.conv_value)} out`}
              />
              <Kpi
                label="Last 7 vs prior 7 spend"
                value={`${money(wow.last.spend)} → prior ${money(wow.prior.spend)}`}
                hint={`${pctDelta(wow.last.spend, wow.prior.spend)} spend · ${pctDelta(wow.last.conv_value, wow.prior.conv_value)} conv. value`}
              />
              <Kpi
                label="Last 7 vs prior 7 ROAS"
                value={`${wow.last.roas.toFixed(2)}x vs ${wow.prior.roas.toFixed(2)}x`}
                hint="Intel cards always use this 7-day window from file as-of"
              />
            </div>
            <Card>
              <CardHeader className="border-b">
                <CardTitle className="text-sm">Spend vs conversion value</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <DualChart daily={data.daily} />
              </CardContent>
            </Card>
            {data.products.some((p) => p.product !== "other" && p.spend >= 1) && (
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                {data.products.filter((p) => p.spend >= 1).map((p) => (
                  <Kpi
                    key={p.product}
                    label={`${p.product} mix`}
                    value={money(p.spend)}
                    hint={`${p.roas.toFixed(2)}x · ${fmtD(p.conversions)} conv`}
                  />
                ))}
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              <WinLose title="Keep" rows={data.wins} empty="No campaign with spend ≥ $1 and ROAS ≥ 1.5x." />
              <WinLose title="Kill / watch" rows={data.losses} empty="No spend ≥ $1 loser. $0 Meta days are hidden." />
            </div>
          </section>

          <section id="intel" className="space-y-3 scroll-mt-12">
            <h2 className="text-sm font-semibold tracking-tight">This week</h2>
            <Card>
              <CardContent className="space-y-3 p-4">
                <p className="text-sm leading-relaxed">{brief.headline || "Upload CSVs to build this week’s brief."}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <p className="text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground">Ads lead. </span>{brief.ads || "No paid-media stack yet."}
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    <span className="font-medium text-foreground">Web team. </span>{brief.site || "No site stack yet."}
                  </p>
                </div>
              </CardContent>
            </Card>
          </section>

          <section id="ads-desk" className="space-y-3 scroll-mt-12">
            <h2 className="text-sm font-semibold tracking-tight">Paid media · for the ads lead</h2>
            <p className="text-[11px] text-muted-foreground">
              7-day keep/kill tests, ranked by $ at stake. Never move Meta or PMax onto Brand Search. Success metric is on every card.
            </p>
            {data.cards.filter((c) => (c.owner ?? "ads") === "ads").length === 0 ? (
              <p className="text-sm text-muted-foreground">No paid-media cards for this filter.</p>
            ) : data.cards.filter((c) => (c.owner ?? "ads") === "ads").map((c, i) => (
              <IntelCardView key={c.id} card={c} index={i} />
            ))}
          </section>

          <section id="site-desk" className="space-y-3 scroll-mt-12">
            <h2 className="text-sm font-semibold tracking-tight">Site &amp; conversion · for the web team</h2>
            <p className="text-[11px] text-muted-foreground">
              Tracking, bounce, titles, and PDP leaks. Send this block as-is. Do not invent a position change from Queries.csv.
            </p>
            {data.cards.filter((c) => c.owner === "site").length === 0 ? (
              <p className="text-sm text-muted-foreground">No site cards for this filter.</p>
            ) : data.cards.filter((c) => c.owner === "site").map((c, i) => (
              <IntelCardView key={c.id} card={c} index={i} />
            ))}
          </section>

          <section id="campaigns" className="space-y-3 scroll-mt-12">
            <h2 className="text-sm font-semibold tracking-tight">Campaigns</h2>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Conv. value</TableHead>
                      <TableHead className="text-right">ROAS</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                      <TableHead className="text-right">Lost IS</TableHead>
                      <TableHead className="text-right">Freq</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.campaigns.filter((c) => c.spend >= 1).map((c) => (
                      <TableRow key={`${c.platform}:${c.campaign_name}`}>
                        <TableCell>
                          <div className="font-medium">{c.campaign_name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {[c.platform, c.campaign_type, c.is_brand ? "brand" : "non-brand", c.product, c.audience !== "unknown" ? c.audience : ""]
                              .filter(Boolean).join(" · ")}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.conv_value)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.roas.toFixed(2)}x</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtD(c.conversions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.lost_is_budget == null ? "—" : `${c.lost_is_budget.toFixed(0)}%`}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.frequency == null ? "—" : c.frequency.toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>

          {!data.gsc.hidden && (
            <section id="gsc" className="space-y-3 scroll-mt-12">
              <h2 className="text-sm font-semibold tracking-tight">Search Console</h2>
              <p className="text-[11px] text-muted-foreground">
                Queries.csv and Pages.csv are snapshots (no date). Chart.csv is the daily organic trend. Position change is never invented from the snapshot.
              </p>
              {data.gsc.chart.length > 0 && (
                <Card>
                  <CardHeader className="border-b">
                    <CardTitle className="text-sm">Organic clicks · Chart.csv</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <ChartSpark chart={data.gsc.chart} />
                  </CardContent>
                </Card>
              )}
              <div className="grid gap-3 lg:grid-cols-2">
                <SimpleList
                  title="Top queries"
                  rows={data.gsc.queries.slice(0, 12).map((q) => ({
                    name: q.query,
                    meta: `pos ${q.position?.toFixed(1) ?? "—"} · CTR ${q.ctr?.toFixed(1) ?? "—"}%`,
                    value: `${fmt(q.clicks)} clicks · ${fmt(q.impressions)} impr`,
                  }))}
                />
                <SimpleList
                  title="Pages · high impression"
                  rows={data.gsc.pages.slice(0, 12).map((q) => ({
                    name: q.query.replace(/^https?:\/\/[^/]+/, ""),
                    meta: `CTR ${q.ctr?.toFixed(2) ?? "—"}% · pos ${q.position?.toFixed(1) ?? "—"}`,
                    value: `${fmt(q.impressions)} impr`,
                  }))}
                />
              </div>
            </section>
          )}

          <section id="ga4" className="space-y-3 scroll-mt-12">
            <h2 className="text-sm font-semibold tracking-tight">GA4 Explore</h2>
            <p className="text-[11px] text-muted-foreground">
              Last-click only. Cross-network ≈ PMax. Do not read Total revenue as Google/Meta conversion value.
              Unassigned {Math.round(data.ga4.unassigned_share * 100)}% · Paid Social {fmt(data.ga4.paid_social_sessions)} sess · Cross-network {fmt(data.ga4.cross_network_sessions)} sess.
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              <SimpleList
                title="Channels"
                rows={data.ga4.channels.slice(0, 10).map((c) => ({
                  name: c.channel,
                  meta: `${fmt(c.key_events)} key events`,
                  value: `${fmt(c.sessions)} sess · ${money(c.revenue)}`,
                }))}
              />
              <SimpleList
                title="Devices"
                rows={data.ga4.devices.map((d) => ({
                  name: d.device,
                  meta: `${(d.cvr * 100).toFixed(1)}% CVR · ${fmt(d.key_events)} key events`,
                  value: `${fmt(d.sessions)} sess · ${money(d.revenue)}`,
                }))}
              />
            </div>
            <SimpleList
              title="Landings"
              rows={data.ga4.landings.slice(0, 10).map((l) => ({
                name: l.page,
                meta: `${l.bounce == null ? "—" : `${Math.round(l.bounce * 100)}% bounce`} · ${fmt(l.key_events)} key events`,
                value: `${fmt(l.sessions)} sess · ${money(l.revenue)}`,
              }))}
            />
          </section>
        </>
      )}
    </div>
  );
}

function WinLose({
  title, rows, empty,
}: {
  title: string;
  rows: IntelBundle["wins"];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-sm">
          {title === "Keep" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">ROAS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 8).map((r) => (
                <TableRow key={`${r.platform}:${r.campaign_name}`}>
                  <TableCell>
                    <div className="font-medium">{r.campaign_name}</div>
                    <div className="text-[10px] text-muted-foreground">{r.platform}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.roas.toFixed(2)}x</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SimpleList({
  title, rows,
}: {
  title: string;
  rows: Array<{ name: string; meta: string; value: string }>;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No rows for this source.</p>
        ) : rows.map((r) => (
          <div key={r.name} className="flex items-start justify-between gap-3 px-4 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm">{r.name}</p>
              <p className="text-[10px] text-muted-foreground">{r.meta}</p>
            </div>
            <p className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{r.value}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function usePaidIntel(range: IntelRangeDays, filter: IntelFilter) {
  const [data, setData] = useState<IntelBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const ac = new AbortController();
    setLoading(true);
    fetch(`/api/paid-ads/intel?range=${range}&filter=${filter}`, { signal: ac.signal })
      .then(async (r) => {
        const json = await r.json();
        if (json.fatalError) throw new Error(json.fatalError);
        const raw = json as IntelBundle;
        setData({
          ...raw,
          brief: raw.brief ?? EMPTY_BRIEF,
          wow: raw.wow ?? { last: raw.kpis?.blended, prior: raw.kpis?.blended },
          cards: (raw.cards ?? []).map((c) => ({ ...c, owner: c.owner === "site" ? "site" : "ads" })),
        });
        setError(json.loadErrors?.length ? json.loadErrors.join(" · ") : null);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
        setData(null);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [range, filter]);

  useEffect(() => load(), [load]);
  return { data, loading, error, reload: () => { load(); } };
}
