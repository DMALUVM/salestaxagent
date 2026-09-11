"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HEATMAP_DEFAULT_ROWS,
  HERO_FAMILIES,
  WOW_MOVE_POSITIONS,
  WOW_TOP_N,
  emptyCopyForFamily,
  filterProgress,
  formatRank,
  formatSfr,
  rankHeatTone,
  wowLabel,
  type HeatmapRow,
  type HeroFamilyId,
  type OrganicRankProgress,
} from "@/lib/organic-rank-progress";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

type SortKey = "sfr" | "keyword" | "rank";

const TONE: Record<string, string> = {
  best: "bg-emerald-600 text-white dark:bg-emerald-500",
  strong: "bg-emerald-400 text-emerald-950 dark:bg-emerald-400/90",
  good: "bg-lime-300 text-lime-950 dark:bg-lime-400/80 dark:text-lime-950",
  mid: "bg-amber-300 text-amber-950 dark:bg-amber-400/80 dark:text-amber-950",
  weak: "bg-orange-400 text-orange-950 dark:bg-orange-500/80",
  poor: "bg-red-500 text-white dark:bg-red-600",
  missing: "bg-muted text-muted-foreground/70",
};

function weekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sortRows(rows: HeatmapRow[], sort: SortKey): HeatmapRow[] {
  const copy = [...rows];
  if (sort === "keyword") {
    return copy.sort((a, b) => a.keyword_normalized.localeCompare(b.keyword_normalized));
  }
  if (sort === "rank") {
    return copy.sort((a, b) => {
      if (a.current != null && b.current != null && a.current !== b.current) {
        return a.current - b.current;
      }
      if (a.current != null && b.current == null) return -1;
      if (a.current == null && b.current != null) return 1;
      return a.keyword_normalized.localeCompare(b.keyword_normalized);
    });
  }
  return copy.sort((a, b) => {
    if (a.sfr != null && b.sfr != null && a.sfr !== b.sfr) return a.sfr - b.sfr;
    if (a.sfr != null && b.sfr == null) return -1;
    if (a.sfr == null && b.sfr != null) return 1;
    return a.keyword_normalized.localeCompare(b.keyword_normalized);
  });
}

export function OrganicRankHeatmap() {
  const [data, setData] = useState<(OrganicRankProgress & { error?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [family, setFamily] = useState<HeroFamilyId | "all">("all");
  const [sort, setSort] = useState<SortKey>("sfr");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch("/api/ppc/organic-rank")
      .then((r) => r.json())
      .then((payload) => {
        setData(payload as OrganicRankProgress);
        setError(payload?.error ? String(payload.error) : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load ranks."));
  }, []);

  const filtered = useMemo(
    () => (data ? filterProgress(data, family) : null),
    [data, family],
  );
  const rows = useMemo(
    () => (filtered ? sortRows(filtered.rows, sort) : []),
    [filtered, sort],
  );
  const visible = showAll ? rows : rows.slice(0, HEATMAP_DEFAULT_ROWS);
  const weeks = filtered?.weeks ?? [];
  const movers = filtered?.movers ?? [];
  const improved = movers.filter((m) => m.wow?.direction === "improved");
  const worsened = movers.filter((m) => m.wow?.direction === "worsened");

  const emptyCopy = !data
    ? "Loading weekly organic ranks…"
    : filtered?.empty
      ? (filtered.emptyCopy || emptyCopyForFamily(family))
      : null;

  return (
    <div id="organic-rank" className="scroll-mt-14 space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">
                Weekly organic rank
              </CardTitle>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Keywords × week from SoldScope Rank Tracker. SFR is Brand
                Analytics (`abaSearchFrequencyRank`) — never invented from
                SoldScope search volume. Greener is a better rank. Meaningful
                WoW is ≥{WOW_MOVE_POSITIONS} positions or crossing top {WOW_TOP_N}.
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {(["all", ...HERO_FAMILIES.map((f) => f.id)] as Array<HeroFamilyId | "all">).map((id) => {
                const fam = HERO_FAMILIES.find((f) => f.id === id);
                const count = data?.families.find((f) => f.id === id)?.phrases;
                return (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={family === id ? "default" : "outline"}
                    className="h-7 text-[10px]"
                    onClick={() => { setFamily(id); setShowAll(false); }}
                  >
                    {id === "all" ? "All heroes" : fam?.label}
                    {id !== "all" && count != null ? ` · ${count}` : ""}
                  </Button>
                );
              })}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">{error}</p>
          )}
          {emptyCopy ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-xs text-muted-foreground">
              {emptyCopy}
            </p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <MoverList
                  title="Improved this week"
                  rows={improved}
                  tone="up"
                />
                <MoverList
                  title="Slipped this week"
                  rows={worsened}
                  tone="down"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground">
                  {rows.length} keyword{rows.length === 1 ? "" : "s"}
                  {weeks.length ? ` · ${weeks.length} week${weeks.length === 1 ? "" : "s"}` : ""}
                  {sort === "sfr" ? " · sorted by SFR (more frequent first)" : ""}
                </p>
                <div className="flex gap-1">
                  {([
                    ["sfr", "SFR"],
                    ["rank", "Rank"],
                    ["keyword", "A–Z"],
                  ] as Array<[SortKey, string]>).map(([key, label]) => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={sort === key ? "default" : "outline"}
                      className="h-6 text-[10px]"
                      onClick={() => setSort(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[640px] border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="sticky left-0 z-10 bg-muted/90 px-2 py-1.5 text-left font-medium">
                        Keyword
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Brand Analytics Search Frequency Rank — lower is more frequent">
                        SFR
                      </th>
                      {weeks.map((w) => (
                        <th key={w} className="px-1.5 py-1.5 text-center font-medium tabular-nums">
                          {weekLabel(w)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={`${row.asin}-${row.keyword_normalized}`} className="border-b last:border-0">
                        <td className="sticky left-0 z-10 max-w-[220px] bg-background px-2 py-1">
                          <div className="truncate font-medium" title={row.keyword}>{row.keyword}</div>
                          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                            {row.family} · {row.asin}
                          </div>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                          {formatSfr(row.sfr)}
                        </td>
                        {weeks.map((w) => {
                          const rank = row.positions[w] ?? null;
                          return (
                            <td key={w} className="px-1 py-1">
                              <span
                                className={`mx-auto flex h-6 w-10 items-center justify-center rounded-sm tabular-nums ${TONE[rankHeatTone(rank)]}`}
                                title={rank == null ? "No rank stored" : `Organic #${rank}`}
                              >
                                {formatRank(rank)}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > HEATMAP_DEFAULT_ROWS && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px]"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? "Show top 40 by this sort" : `Show all ${rows.length} keywords`}
                </Button>
              )}
              <p className="text-[10px] text-muted-foreground">
                Color: 1–3 dark green · 4–10 green · 11–20 lime · 21–50 amber ·
                51–100 orange · 100+ red · missing muted.
                Deo stays empty until a Rank Tracker group exists — observe-only.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MoverList({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: HeatmapRow[];
  tone: "up" | "down";
}) {
  const Icon = tone === "up" ? ArrowUpRight : ArrowDownRight;
  const border = tone === "up"
    ? "border-emerald-200 dark:border-emerald-900"
    : "border-red-200 dark:border-red-900";
  const iconCls = tone === "up"
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";

  return (
    <div className={`rounded-md border ${border} p-2.5`}>
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium">
        <Icon className={`h-3.5 w-3.5 ${iconCls}`} />
        {title}
        <Badge variant="outline" className="text-[9px]">{rows.length}</Badge>
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No meaningful {tone === "up" ? "gains" : "drops"} vs last week.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 8).map((row) => (
            <li key={`${row.asin}-${row.keyword_normalized}`} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate">
                <span className="font-medium">{row.keyword}</span>
                <span className="ml-1 text-[9px] uppercase text-muted-foreground">
                  {row.family}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatRank(row.previous)}→{formatRank(row.current)}
                <span className={`ml-1 ${iconCls}`}>{wowLabel(row.wow)}</span>
                {row.sfr != null && (
                  <span className="ml-1 text-[9px]">SFR {formatSfr(row.sfr)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
