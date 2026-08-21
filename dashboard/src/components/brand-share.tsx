"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Branded vs non-branded market share — the leadership-meeting view.
 *
 * Automates the DASHBOARD sheet of the manual Branded Market Share Tracker.
 * Three ratios that get confused constantly are labelled explicitly:
 *   mix    = of OUR purchases, how much came from branded queries
 *   share  = of the MARKET's purchases on those queries, how much was ours
 * A high branded mix with a tiny non-brand share is the "we own our name and
 * nothing else" position — which is the point of showing them together.
 */
interface Week {
  week_start: string;
  week_end: string | null;
  brandedPurchases: number;
  nonBrandedPurchases: number;
  totalPurchases: number;
  brandedMix: number | null;
  brandedShare: number | null;
  nonBrandedShare: number | null;
}
interface Opp {
  query: string; market: number; ours: number; share: number; unclaimed: number;
}
interface Payload {
  available: boolean;
  weeks: Week[];
  opportunities: Opp[];
  callouts: string[];
  setupHint?: string | null;
  error?: string | null;
  meta?: { rowsRead: number; weekCount: number; firstWeek: string | null;
           lastWeek: string | null } | null;
}

const pct = (v: number | null | undefined, dp = 0) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(dp)}%`;

/** Trailing window, matched to the API. History is never capped below this. */
const MAX_WEEKS = 52;

/** A week with no stored data — plotted as an empty column, never skipped. */
type Column = { week: Week | null; week_start: string };

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * One column per calendar week between the first and last stored week.
 *
 * Plotting only the weeks that have rows would silently close a gap: a missing
 * sync would render as an unbroken trend rather than as the hole it is. Every
 * week that exists in the payload is plotted (never a "last N" subset), and
 * anything absent in between becomes an empty column.
 */
function toColumns(weeks: Week[]): Column[] {
  if (!weeks.length) return [];
  const byStart = new Map(weeks.map((w) => [w.week_start, w]));
  const out: Column[] = [];
  const last = weeks[weeks.length - 1].week_start;
  let cursor = weeks[0].week_start;
  // Bounded by MAX_WEEKS so a bad date can never spin this loop.
  for (let i = 0; cursor <= last && i <= MAX_WEEKS + 1; i++) {
    out.push({ week_start: cursor, week: byStart.get(cursor) ?? null });
    cursor = addDays(cursor, 7);
  }
  return out;
}

export function BrandShare() {
  const [d, setD] = useState<Payload | null>(null);

  useEffect(() => {
    fetch("/api/brand-share").then((r) => r.json()).then(setD).catch(() => setD(null));
  }, []);

  if (!d) return null;

  // Every stored week the API returned, chronological, newest last. The old
  // slice(-15) was a second cap stacked on an already-truncated payload.
  const weeks = (d.weeks ?? []).slice(-MAX_WEEKS);
  const latest = weeks[weeks.length - 1];
  const columns = toColumns(weeks);
  const maxMix = Math.max(...weeks.map((w) => w.brandedMix ?? 0), 0.01);
  // The KPI strip, the bullets and the bars all read this same array, so they
  // cannot disagree about which week is "latest".
  const spanLabel = weeks.length
    ? `${weeks.length} week${weeks.length === 1 ? "" : "s"} · ` +
      `${weeks[0].week_start} → ${latest?.week_end ?? latest?.week_start}`
    : "no weeks stored";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Branded vs non-branded
          <span className="ml-2 font-normal text-muted-foreground">
            {spanLabel} · Search Query Performance
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!d.available || weeks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {d.setupHint ?? d.error ?? "No SQP weeks stored yet."}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Branded mix of our purchases
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {pct(latest?.brandedMix)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {latest?.brandedPurchases?.toLocaleString()} branded /{" "}
                  {latest?.totalPurchases?.toLocaleString()} total
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Share of branded demand
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  {pct(latest?.brandedShare)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  of market purchases on branded queries
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground">
                  Share of non-brand demand
                </p>
                <p className="text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                  {pct(latest?.nonBrandedShare, 1)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  the category growth headroom
                </p>
              </div>
            </div>

            {d.callouts?.length > 0 && (
              <ul className="space-y-1">
                {d.callouts.map((c, i) => (
                  <li key={i} className="text-xs text-amber-700 dark:text-amber-400">
                    • {c}
                  </li>
                ))}
              </ul>
            )}

            {/* Mix trend — one bar per week, branded portion filled. */}
            <div>
              <p className="text-[10px] uppercase text-muted-foreground mb-1">
                Branded mix by week
              </p>
              {/* Each column is its own positioning context and clips its fill.
                  The fill is anchored to the bottom with `absolute bottom-0`,
                  NOT offset with a percentage margin: percentage margins resolve
                  against the containing block's WIDTH, not its height. At ~300px
                  per column a 3% mix produced marginTop ≈ 290px inside a 64px
                  box, so the bar escaped the chart and painted over the
                  opportunities table below. overflow-hidden is the second belt:
                  nothing in this chart can ever render outside its own column. */}
              <div className="flex items-end gap-px overflow-hidden" style={{ height: 64 }}>
                {columns.map((c) => {
                  const w = c.week;
                  const fillPct = Math.max(
                    0,
                    Math.min(100, ((w?.brandedMix ?? 0) / maxMix) * 100),
                  );
                  return (
                    <div
                      key={c.week_start}
                      className={`relative h-full flex-1 overflow-hidden rounded-t ${
                        w ? "bg-muted" : "bg-transparent border-b border-dashed border-muted"
                      }`}
                      title={
                        w
                          ? `${w.week_start} → ${w.week_end ?? "?"}: mix ${pct(w.brandedMix)} · branded share ${pct(w.brandedShare)} · non-brand share ${pct(w.nonBrandedShare, 1)}`
                          : `${c.week_start}: no SQP data stored for this week`
                      }
                    >
                      {w && (
                        <div
                          className="absolute inset-x-0 bottom-0 rounded-t bg-[#2a78d6] dark:bg-[#3987e5]"
                          style={{ height: `${fillPct}%` }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-muted-foreground tabular-nums">
                <span>{weeks[0]?.week_start}</span>
                <span>{latest?.week_end ?? latest?.week_start}</span>
              </div>
            </div>

            {d.opportunities?.length > 0 && (
              <div>
                <p className="text-[10px] uppercase text-muted-foreground mb-1">
                  Top non-brand opportunities — market demand we are not capturing
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-3">Query</th>
                        <th className="py-1 pr-3 text-right">Market</th>
                        <th className="py-1 pr-3 text-right">Ours</th>
                        <th className="py-1 pr-3 text-right">Share</th>
                        <th className="py-1 text-right">Unclaimed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.opportunities.map((o) => (
                        <tr key={o.query} className="border-t">
                          <td className="py-1 pr-3">{o.query}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {o.market.toLocaleString()}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {o.ours.toLocaleString()}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {pct(o.share, 1)}
                          </td>
                          <td className="py-1 text-right tabular-nums font-medium">
                            {o.unclaimed.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        <p className="text-[10px] text-muted-foreground">
          Source: SP-API Search Query Performance (<span className="font-medium">ASIN view</span>).
          Denominators cover queries our ASINs appeared in — not the full
          category, so this is not Brand View parity. Trend is reliable; the
          absolute share level is flattering.{" "}
          <Badge variant="outline" className="text-[9px]">weekly</Badge>
        </p>
      </CardContent>
    </Card>
  );
}
