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
}

const pct = (v: number | null | undefined, dp = 0) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(dp)}%`;

export function BrandShare() {
  const [d, setD] = useState<Payload | null>(null);

  useEffect(() => {
    fetch("/api/brand-share").then((r) => r.json()).then(setD).catch(() => setD(null));
  }, []);

  if (!d) return null;

  const weeks = (d.weeks ?? []).slice(-15);
  const latest = weeks[weeks.length - 1];
  const maxMix = Math.max(...weeks.map((w) => w.brandedMix ?? 0), 0.01);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Branded vs non-branded
          <span className="ml-2 font-normal text-muted-foreground">
            last {weeks.length} weeks · Search Query Performance
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
              <div className="flex items-end gap-1" style={{ height: 64 }}>
                {weeks.map((w) => (
                  <div
                    key={w.week_start}
                    className="flex-1 rounded-t bg-muted"
                    style={{ height: "100%" }}
                    title={`${w.week_start}: mix ${pct(w.brandedMix)} · branded share ${pct(w.brandedShare)} · non-brand share ${pct(w.nonBrandedShare, 1)}`}
                  >
                    <div
                      className="w-full rounded-t bg-[#2a78d6] dark:bg-[#3987e5]"
                      style={{
                        height: `${((w.brandedMix ?? 0) / maxMix) * 100}%`,
                        marginTop: `${100 - ((w.brandedMix ?? 0) / maxMix) * 100}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-muted-foreground tabular-nums">
                <span>{weeks[0]?.week_start}</span>
                <span>{latest?.week_start}</span>
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
