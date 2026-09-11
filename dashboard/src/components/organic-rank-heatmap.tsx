"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BASELINE_WEEK_COPY,
  HEATMAP_DEFAULT_ROWS,
  HERO_FAMILIES,
  WOW_MOVE_POSITIONS,
  WOW_TOP_N,
  cellHoverTitle,
  cellPriorRank,
  classifyMovement,
  emptyCopyForFamily,
  filterProgress,
  formatCellRank,
  formatSfr,
  formatSignedDelta,
  rankHeatTone,
  sortHeatmapRows,
  sparklineGeometry,
  sparklineSeries,
  wowLabel,
  type HeatmapRow,
  type HeatmapSortKey,
  type HeroFamilyId,
  type MoveDirection,
  type OrganicRankProgress,
} from "@/lib/organic-rank-progress";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

const TONE: Record<string, { cell: string; ink: "light" | "dark" }> = {
  best: { cell: "bg-emerald-600 text-white dark:bg-emerald-500", ink: "light" },
  strong: { cell: "bg-emerald-400 text-emerald-950 dark:bg-emerald-400/90", ink: "dark" },
  good: { cell: "bg-lime-300 text-lime-950 dark:bg-lime-400/80 dark:text-lime-950", ink: "dark" },
  mid: { cell: "bg-amber-300 text-amber-950 dark:bg-amber-400/80 dark:text-amber-950", ink: "dark" },
  weak: { cell: "bg-orange-400 text-orange-950 dark:bg-orange-500/80", ink: "dark" },
  poor: { cell: "bg-red-500 text-white dark:bg-red-600", ink: "light" },
  missing: { cell: "bg-muted text-muted-foreground/70", ink: "dark" },
};

const LEGEND_SWATCHES: Array<{ tone: keyof typeof TONE; label: string }> = [
  { tone: "best", label: "1–3" },
  { tone: "strong", label: "4–10" },
  { tone: "good", label: "11–20" },
  { tone: "mid", label: "21–50" },
  { tone: "weak", label: "51–100" },
  { tone: "poor", label: "100+" },
  { tone: "missing", label: "no rank" },
];

function weekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function rowShade(row: HeatmapRow): string {
  const move = classifyMovement(row.previous, row.current);
  if (move.meaningful && move.direction === "improved") {
    return "bg-emerald-50/90 dark:bg-emerald-950/40";
  }
  if (move.meaningful && move.direction === "worsened") {
    return "bg-rose-50/90 dark:bg-rose-950/40";
  }
  if (move.anyMove && move.direction === "improved") {
    return "bg-emerald-50/45 dark:bg-emerald-950/20";
  }
  if (move.anyMove && move.direction === "worsened") {
    return "bg-rose-50/45 dark:bg-rose-950/20";
  }
  return "";
}

function deltaChip(direction: MoveDirection): string {
  if (direction === "improved") return "bg-white/90 text-emerald-700";
  if (direction === "worsened") return "bg-white/90 text-rose-700";
  if (direction === "unchanged") return "bg-black/10 text-current/70";
  return "";
}

export function OrganicRankHeatmap() {
  const [data, setData] = useState<(OrganicRankProgress & { error?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [family, setFamily] = useState<HeroFamilyId | "all">("all");
  const [sort, setSort] = useState<HeatmapSortKey>("sfr");
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
    () => (filtered ? sortHeatmapRows(filtered.rows, sort) : []),
    [filtered, sort],
  );
  const visible = showAll ? rows : rows.slice(0, HEATMAP_DEFAULT_ROWS);
  const weeks = filtered?.weeks ?? [];
  const movers = filtered?.movers ?? [];
  const improved = movers.filter((m) => m.wow?.direction === "improved");
  const worsened = movers.filter((m) => m.wow?.direction === "worsened");
  const movedCount = rows.filter((r) => classifyMovement(r.previous, r.current).anyMove).length;
  const flaggedCount = movers.length;
  const baselineOnly = Boolean(filtered?.baselineOnly);

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
                SoldScope search volume. Cell fill is absolute rank (greener =
                better). The small Δ is movement vs the prior week, or vs
                SoldScope previous position when only one week is stored.
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

              {baselineOnly && weeks[0] && (
                <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  {BASELINE_WEEK_COPY}{" "}
                  Week of {weekLabel(weeks[0])}. {movedCount} of {rows.length} keywords
                  moved; {flaggedCount} flagged as meaningful (≥{WOW_MOVE_POSITIONS}{" "}
                  or crossing top {WOW_TOP_N}).
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground">
                  {rows.length} keyword{rows.length === 1 ? "" : "s"}
                  {weeks.length ? ` · ${weeks.length} week${weeks.length === 1 ? "" : "s"}` : ""}
                  {movedCount ? ` · ${movedCount} moved` : ""}
                  {flaggedCount ? ` · ${flaggedCount} flagged` : ""}
                  {sort === "sfr" ? " · sorted by SFR (more frequent first)" : ""}
                  {sort === "moved" ? " · movers first" : ""}
                </p>
                <div className="flex gap-1">
                  {([
                    ["sfr", "SFR"],
                    ["rank", "Rank"],
                    ["moved", "Moved"],
                    ["keyword", "A–Z"],
                  ] as Array<[HeatmapSortKey, string]>).map(([key, label]) => (
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
                <table className="w-full min-w-[720px] border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="sticky left-0 z-10 bg-muted/90 px-2 py-1.5 text-left font-medium">
                        Keyword
                      </th>
                      <th className="px-1.5 py-1.5 text-center font-medium" title="Prior → current trend. Lower (toward #1) is up.">
                        Trend
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
                    {visible.map((row) => {
                      const shade = rowShade(row);
                      return (
                        <tr
                          key={`${row.asin}-${row.keyword_normalized}`}
                          className={`border-b last:border-0 ${shade}`}
                        >
                          <td className={`sticky left-0 z-10 max-w-[220px] px-2 py-1.5 ${shade || "bg-background"}`}>
                            <div className="truncate font-medium" title={row.keyword}>{row.keyword}</div>
                            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                              {row.family} · {row.asin}
                            </div>
                          </td>
                          <td className="px-1.5 py-1.5">
                            <RankSpark row={row} weeks={weeks} />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                            {formatSfr(row.sfr)}
                          </td>
                          {weeks.map((w) => {
                            const rank = row.positions[w] ?? null;
                            const prior = cellPriorRank(row, w, weeks);
                            return (
                              <td key={w} className="px-1 py-1.5">
                                <RankCell rank={rank} prior={prior} sfr={row.sfr} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
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
              <Legend />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RankCell({
  rank,
  prior,
  sfr,
}: {
  rank: number | null;
  prior: number | null;
  sfr: number | null;
}) {
  const tone = TONE[rankHeatTone(rank)];
  const move = classifyMovement(prior, rank);
  const chip = deltaChip(move.direction);
  return (
    <span
      className={`mx-auto flex h-10 min-w-[3.4rem] flex-col items-center justify-center rounded-md px-1 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] ${tone.cell}`}
      title={cellHoverTitle({ previous: prior, current: rank, sfr })}
    >
      <span className="text-[11px] font-semibold tabular-nums leading-none">
        {formatCellRank(rank)}
      </span>
      {move.direction !== "unknown" && chip && (
        <span className={`mt-1 inline-flex items-center rounded px-1 text-[8px] font-semibold leading-none ${chip}`}>
          {formatSignedDelta(move.delta)}
        </span>
      )}
    </span>
  );
}

function RankSpark({ row, weeks }: { row: HeatmapRow; weeks: string[] }) {
  const values = sparklineSeries(row, weeks);
  const geo = sparklineGeometry(values);
  const stroke =
    geo.direction === "improved" ? "#059669"
      : geo.direction === "worsened" ? "#e11d48"
        : geo.direction === "unchanged" ? "#78716c"
          : "#a8a29e";
  const title = values.length
    ? cellHoverTitle({
        previous: values[0],
        current: values[values.length - 1],
        sfr: row.sfr,
      })
    : "No rank series";
  if (geo.points.length === 0) {
    return <span className="block text-center text-[10px] text-muted-foreground/50">—</span>;
  }
  return (
    <span title={title} className="mx-auto block w-[56px]">
      <svg width={56} height={18} className="block" aria-hidden>
        {geo.points.length >= 2 && (
          <polyline
            fill="none"
            stroke={stroke}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={geo.polyline}
          />
        )}
        {geo.points.map((p, i) => (
          <circle
            key={`${p.x}-${p.y}-${i}`}
            cx={p.x}
            cy={p.y}
            r={i === geo.points.length - 1 ? 2 : 1.4}
            fill={i === geo.points.length - 1 ? stroke : "currentColor"}
            className={i === geo.points.length - 1 ? undefined : "text-foreground/50"}
          />
        ))}
      </svg>
    </span>
  );
}

function Legend() {
  return (
    <div className="space-y-1.5 text-[10px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground/70">Rank fill</span>
        {LEGEND_SWATCHES.map((s) => (
          <span key={s.tone} className="inline-flex items-center gap-1">
            <span className={`h-2.5 w-2.5 rounded-sm ${TONE[s.tone].cell}`} />
            {s.label}
          </span>
        ))}
      </div>
      <p>
        Movement: <span className="font-medium text-emerald-700 dark:text-emerald-400">↑ green</span> is
        a better rank, <span className="font-medium text-rose-700 dark:text-rose-400">↓ red</span> is
        worse, <span className="text-foreground/60">0</span> is unchanged.
        Any 1+ move tints the row; a stronger tint plus the lists means
        meaningful (≥{WOW_MOVE_POSITIONS} positions or crossing top {WOW_TOP_N}).
        Trend is prior → current (lower toward #1 reads as up).
      </p>
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
                {row.previous ?? "—"}→{row.current ?? "—"}
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
