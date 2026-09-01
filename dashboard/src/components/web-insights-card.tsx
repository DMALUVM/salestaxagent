"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { WebInsights } from "@/lib/paid-intel/types";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function money(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function WindowLine({ insights }: { insights: WebInsights }) {
  const bits = [
    insights.windows.ga4 ? `GA4 ${insights.windows.ga4.label}` : null,
    insights.windows.campaigns ? `ads ${insights.windows.campaigns.label}` : null,
    insights.windows.gsc_pages ? `GSC pages ${insights.windows.gsc_pages.label}` : null,
    insights.windows.gsc_queries ? `GSC queries ${insights.windows.gsc_queries.label}` : null,
    insights.windows.gsc_chart ? `Chart ${insights.windows.gsc_chart.label}` : null,
  ].filter(Boolean);
  if (!bits.length) return null;
  return <p className="text-[11px] text-muted-foreground">{bits.join(" · ")}</p>;
}

function Gap({ text }: { text: string }) {
  return <p className="text-[12px] text-amber-700 dark:text-amber-400">{text}</p>;
}

function EmptyBlock({ text }: { text: string }) {
  return <p className="text-[12px] text-muted-foreground">{text}</p>;
}

export function WebInsightsCard({ insights }: { insights: WebInsights }) {
  if (!insights.present) return null;
  const offPage = insights.money_queries.filter((q) => q.kind === "off_page_1");
  const branded = insights.money_queries.filter((q) => q.kind === "branded_pos1_zero_clicks");
  return (
    <section id="web-insights" className="space-y-3 scroll-mt-12">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Web insights</h2>
        <p className="text-[11px] text-muted-foreground">
          Site half of this upload. Ads Ops still ranks ad levers below. Same windows as the files — nothing invented.
        </p>
      </div>
      <Card>
        <CardHeader className="space-y-1 border-b">
          <CardTitle className="text-sm">Web insights</CardTitle>
          <WindowLine insights={insights} />
        </CardHeader>
        <CardContent className="space-y-5 p-4">
          <p className="text-[13px] leading-relaxed">{insights.site_vs_ad}</p>
          {insights.gaps.map((g) => <Gap key={g} text={g} />)}

          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold">GA4 converting landings vs where ads send traffic</h3>
            {insights.converting_landings.length === 0 && insights.ad_landings.length === 0 ? (
              <EmptyBlock text={insights.gaps.find((g) => /GA4/.test(g)) ?? "No converting landings in this window."} />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                <LandingTable
                  title="Conversions happen here"
                  rows={insights.converting_landings}
                  empty="No landing with key events or revenue in this window."
                />
                <LandingTable
                  title="Paid GA4 sends traffic here"
                  rows={insights.ad_landings}
                  empty="No Paid Search / Paid Social / Cross-network landings in this window. Campaign daily has no landing URL."
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold">GSC pages — high impressions, CTR under 1%</h3>
            {insights.low_ctr_pages.length === 0 ? (
              <EmptyBlock text={insights.windows.gsc_pages
                ? "No page in this snapshot has high impressions and CTR under 1%."
                : "GSC Pages.csv not uploaded — high-impression / low-CTR URLs are a gap."} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead className="text-right">Impr</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {insights.low_ctr_pages.map((p) => (
                    <TableRow key={p.url}>
                      <TableCell className="font-medium">{p.path}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(p.impressions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(p.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.ctr != null ? `${p.ctr.toFixed(1)}%` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold">GSC queries — money terms off page 1, branded pos-1 with 0 clicks</h3>
            {insights.windows.gsc_queries && insights.windows.gsc_chart ? (
              <p className="text-[11px] text-muted-foreground">
                Queries {insights.windows.gsc_queries.label} vs chart {insights.windows.gsc_chart.label}. Dates are blank on query/page rows — not invented.
              </p>
            ) : insights.windows.gsc_queries ? (
              <p className="text-[11px] text-muted-foreground">
                Queries {insights.windows.gsc_queries.label}. Chart.csv not in this upload.
              </p>
            ) : null}
            {insights.money_queries.length === 0 ? (
              <EmptyBlock text={insights.windows.gsc_queries
                ? "No money term off page 1 and no branded pos-1 with 0 clicks in this snapshot."
                : "GSC Queries.csv not uploaded — money-term ranks are a gap."} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Query</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead className="text-right">Pos</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Impr</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...offPage, ...branded].map((q) => (
                    <TableRow key={`${q.kind}:${q.query}`}>
                      <TableCell className="font-medium">{q.query}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">
                        {q.kind === "off_page_1" ? "off page 1" : "pos-1 branded, 0 clicks"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{q.position != null ? q.position.toFixed(1) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(q.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(q.impressions)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-[12px] font-semibold">Channel gap — ad spend vs GA4 Paid Search / Paid Social</h3>
            {insights.channel_gaps.length === 0 ? (
              <EmptyBlock text={insights.gaps.find((g) => /campaign days/.test(g)) ?? "No Google or Meta spend in this window."} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ads</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead>GA4 channel</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Key ev</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {insights.channel_gaps.map((g) => (
                    <TableRow key={g.platform}>
                      <TableCell className="font-medium capitalize">{g.platform}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(g.spend)}</TableCell>
                      <TableCell>{g.ga_channel}</TableCell>
                      <TableCell className="text-right tabular-nums">{g.sessions == null ? "—" : fmt(g.sessions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{g.key_events == null ? "—" : fmt(g.key_events)}</TableCell>
                      <TableCell className="text-right tabular-nums">{g.revenue == null ? "—" : money(g.revenue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function LandingTable({
  title, rows, empty,
}: {
  title: string;
  rows: WebInsights["converting_landings"];
  empty: string;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
      {rows.length === 0 ? (
        <EmptyBlock text={empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Landing</TableHead>
              <TableHead className="text-right">Sess</TableHead>
              <TableHead className="text-right">Key ev</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.page}>
                <TableCell className="font-medium">{r.page}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.sessions)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.key_events)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.revenue)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
