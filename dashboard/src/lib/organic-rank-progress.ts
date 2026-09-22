/**
 * Organic-rank progress for hero ASINs (daily RT snapshots).
 *
 * Positions come from soldscope_rank_snapshots (SoldScope Rank Tracker).
 * SFR SoT is Brand Analytics via SoldScope phrases/v2
 * (`aba_search_frequency_rank`). sqp_weekly + keyword_organic_rank are
 * joined for shares / derived SQP rank only — never invent SFR from
 * SoldScope searchVolume.
 *
 * Empty snapshots stay empty. Deo with no RT group is an honest empty.
 */
import { HERO_ASINS, normalizeKeyword } from "@/lib/soldscope-status";

export const WOW_MOVE_POSITIONS = 5;
export const WOW_TOP_N = 50;
export const HEATMAP_WEEK_CAP = 12;
export const HEATMAP_DEFAULT_ROWS = 40;

export const RANK_EMPTY_COPY =
  "No daily organic-rank snapshots yet. The daily SoldScope Rank Tracker job stores phrases when a hero group already exists. Empty is real — this is not a sales or ads number, and this desk never creates Rank Tracker groups.";

export const DEO_EMPTY_COPY =
  "Deodorant is not in Rank Tracker yet. No rows invented — add a SoldScope RT group for B0HBSZ71XQ when you are ready. This desk never creates groups or phrases.";

export const FAMILY_EMPTY_COPY =
  "No Rank Tracker snapshots for this hero yet. Empty is real — nothing invented, and no group is created from this desk.";

export const BASELINE_WEEK_COPY =
  "First baseline snapshot — one as_of column so far. Movement is vs SoldScope previous position when stored, not a second daily column yet.";

export type HeroFamilyId = "lip" | "balm" | "deo";

export type HeroFamily = {
  id: HeroFamilyId;
  label: string;
  asin: string;
  title: string;
};

export const HERO_FAMILIES: HeroFamily[] = [
  { id: "lip", label: "Lip", asin: "B0CLHTF8YN", title: "Tallowbourn Lip Balm" },
  { id: "balm", label: "Balm", asin: "B0DQFKMJFY", title: "Tallowbourn Tallow Balm" },
  { id: "deo", label: "Deo", asin: "B0HBSZ71XQ", title: "Tallowbourn Tallow Deodorant" },
];

export type WowDirection = "improved" | "worsened";
export type WowReason = "moved" | "entered_top_n" | "exited_top_n";
export type MoveDirection = "improved" | "worsened" | "unchanged" | "unknown";
export type HeatmapSortKey = "sfr" | "keyword" | "rank" | "moved";
export type HeatmapSortDir = "asc" | "desc";

/** Preset toolbar keys, plus `week` for a daily rank column (`week` ISO date). */
export type HeatmapSortSpec = {
  key: HeatmapSortKey | "week";
  dir: HeatmapSortDir;
  /** ISO date (`YYYY-MM-DD`) of a daily rank column when key === "week". */
  week?: string;
};

/** Default grid order: SFR ascending (more frequent first). Null SFR last. */
export const DEFAULT_HEATMAP_SORT: HeatmapSortSpec = { key: "sfr", dir: "asc" };

export type WowFlag = {
  direction: WowDirection;
  reason: WowReason;
  delta: number | null;
};

export type RankSnapshot = {
  phrase?: string | null;
  asin?: string | null;
  organic_position?: number | null;
  organic_previous_position?: number | null;
  organic_asin?: string | null;
  amazon_choice?: boolean | null;
  aba_search_frequency_rank?: number | null;
  aba_total_click_share?: number | null;
  aba_total_conv_share?: number | null;
  search_volume?: number | null;
  as_of?: string | null;
  group_id?: number | null;
};

/** Per-child rank from soldscope_rank_variation_snapshots. Never invent. */
export type VariationSnapshot = {
  phrase?: string | null;
  asin?: string | null;
  variation_asin?: string | null;
  theme?: string | null;
  organic_position?: number | null;
  amazon_choice?: boolean | null;
  as_of?: string | null;
  group_id?: number | null;
};

export type VariationDaySlot = {
  asin: string;
  theme: string | null;
  rank: number | null;
  amazon_choice: boolean | null;
};

export type VariationChip = {
  asin: string;
  theme: string | null;
  label: string;
  rank: number | null;
  delta: number | null;
  amazon_choice: boolean | null;
  winner: boolean;
};

export type SqpJoinRow = {
  asin?: string | null;
  query_normalized?: string | null;
  week_start?: string | null;
  click_share?: number | null;
  impression_share?: number | null;
  search_query_volume?: number | null;
};

export type KorJoinRow = {
  asin?: string | null;
  keyword_normalized?: string | null;
  as_of?: string | null;
  organic_rank?: number | null;
  impression_share_organic?: number | null;
};

export type HeatmapRow = {
  keyword: string;
  keyword_normalized: string;
  asin: string;
  family: HeroFamilyId;
  sfr: number | null;
  sfr_source: "aba" | null;
  sqp_click_share: number | null;
  sqp_organic_rank: number | null;
  positions: Record<string, number | null>;
  /** Child ASIN holding the organic slot, per day. Missing days stay null. */
  organic_child_asins: Record<string, string | null>;
  amazon_choices: Record<string, boolean | null>;
  /** Latest (or most recent stored) child ASIN for the keyword chip. */
  organic_child_asin: string | null;
  /** Tracked child ranks per day. Missing children are omitted — never invented. */
  variation_slots: Record<string, VariationDaySlot[]>;
  previous: number | null;
  current: number | null;
  wow: WowFlag | null;
};

export type OrganicRankProgress = {
  empty: boolean;
  emptyCopy: string;
  families: Array<HeroFamily & { phrases: number; weeks: number }>;
  weeks: string[];
  rows: HeatmapRow[];
  movers: HeatmapRow[];
  thresholds: { movePositions: number; topN: number };
  /** True when the grid has rows but only one snapshot week. */
  baselineOnly: boolean;
};

export type Movement = {
  delta: number | null;
  direction: MoveDirection;
  anyMove: boolean;
  meaningful: boolean;
};

export type SparkPoint = { x: number; y: number; v: number };

export function familyOfAsin(asin: string | null | undefined): HeroFamily | null {
  const key = String(asin ?? "").trim().toUpperCase();
  return HERO_FAMILIES.find((f) => f.asin === key) ?? null;
}

export function emptyCopyForFamily(family: HeroFamilyId | "all"): string {
  if (family === "deo") return DEO_EMPTY_COPY;
  if (family === "all") return RANK_EMPTY_COPY;
  return FAMILY_EMPTY_COPY;
}

export function asRank(value: number | null | undefined): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Meaningful WoW: improve ≥5 positions or enter top 50;
 * worsen ≥5 or fall out of top 50. Smaller drift is noise.
 */
export function classifyWowDelta(
  previous: number | null | undefined,
  current: number | null | undefined,
  opts?: { move?: number; topN?: number },
): WowFlag | null {
  const move = opts?.move ?? WOW_MOVE_POSITIONS;
  const topN = opts?.topN ?? WOW_TOP_N;
  const prev = asRank(previous);
  const cur = asRank(current);
  if (prev == null && cur == null) return null;

  const wasTop = prev != null && prev <= topN;
  const isTop = cur != null && cur <= topN;
  if (!wasTop && isTop) {
    return {
      direction: "improved",
      reason: "entered_top_n",
      delta: prev != null && cur != null ? prev - cur : null,
    };
  }
  if (wasTop && !isTop) {
    return {
      direction: "worsened",
      reason: "exited_top_n",
      delta: prev != null && cur != null ? prev - cur : null,
    };
  }
  if (prev != null && cur != null) {
    const delta = prev - cur;
    if (delta >= move) return { direction: "improved", reason: "moved", delta };
    if (delta <= -move) return { direction: "worsened", reason: "moved", delta };
  }
  return null;
}

/** Positive = better rank (moved toward #1). Both sides must be stored. */
export function rankDelta(
  previous: number | null | undefined,
  current: number | null | undefined,
): number | null {
  const prev = asRank(previous);
  const cur = asRank(current);
  if (prev == null || cur == null) return null;
  return prev - cur;
}

/**
 * Any-move vs meaningful. Grid uses anyMove (even 1–4); flag lists use
 * classifyWowDelta. Never invents a numeric Δ when either rank is missing.
 */
export function classifyMovement(
  previous: number | null | undefined,
  current: number | null | undefined,
): Movement {
  const wow = classifyWowDelta(previous, current);
  const delta = rankDelta(previous, current);
  if (delta == null) {
    return {
      delta: null,
      direction: wow?.direction ?? "unknown",
      anyMove: false,
      meaningful: wow != null,
    };
  }
  const direction: MoveDirection =
    delta > 0 ? "improved" : delta < 0 ? "worsened" : "unchanged";
  return {
    delta,
    direction,
    anyMove: delta !== 0,
    meaningful: wow != null,
  };
}

export function formatSignedDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(Number(delta))) return "";
  const n = Math.trunc(Number(delta));
  if (n === 0) return "0";
  return n > 0 ? `↑${n}` : `↓${Math.abs(n)}`;
}

export function formatCellRank(n: number | null | undefined): string {
  const r = asRank(n);
  return r == null ? "—" : `#${r}`;
}

export function asOrganicChild(asin: string | null | undefined): string | null {
  const a = String(asin ?? "").trim().toUpperCase();
  return a || null;
}

/** Last 4 of a child ASIN for heatmap cells. Full value stays on hover. */
export function shortOrganicChild(asin: string | null | undefined): string {
  const a = asOrganicChild(asin);
  if (!a) return "";
  return a.length <= 4 ? a : a.slice(-4);
}

/**
 * SoldScope theme → short chip label.
 * ``Color: Peppermint`` / ``Scent: Sweet Orange / Size: 3-pack`` → values only.
 * Empty theme stays null — fall back to last-4 of the ASIN at render time.
 */
export function variationThemeLabel(theme: string | null | undefined): string | null {
  const raw = String(theme ?? "").trim();
  if (!raw) return null;
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  const values = parts.map((part) => {
    const idx = part.indexOf(":");
    return idx >= 0 ? part.slice(idx + 1).trim() : part;
  }).filter(Boolean);
  const label = values.join(" / ").trim();
  return label || null;
}

export function shortVariationLabel(
  asin: string | null | undefined,
  theme?: string | null,
): string {
  return variationThemeLabel(theme) || shortOrganicChild(asin);
}

/** Size / pack / strength segments — drop when a scent/theme remains. */
function isPackSizePart(part: string): boolean {
  const p = part.trim();
  if (!p) return true;
  if (/\b(ounce|oz\.?|count|ct\.?)\b/i.test(p) && /\d/.test(p)) return true;
  if (/\bpack of \d+\b/i.test(p)) return true;
  if (/^\d+[-\s]?packs?$/i.test(p)) return true;
  if (/^(extra strength|travel size|refill)$/i.test(p)) return true;
  return false;
}

/**
 * Glance label for a heatmap chip. Prefers the scent/theme segment,
 * drops pack-size prefixes, then ellipsizes. Full string stays on hover.
 */
export function compactVariationLabel(
  label: string | null | undefined,
  opts?: { maxLen?: number },
): string {
  const maxLen = opts?.maxLen ?? 22;
  const raw = String(label ?? "").trim();
  if (!raw) return "";
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  const keep = parts.filter((p) => !isPackSizePart(p));
  const chosen = (keep.length > 0 ? keep : parts).join(" / ");
  if (chosen.length <= maxLen) return chosen;
  return `${chosen.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

export function variationSlotHoverTitle(slot: VariationChip): string {
  const rankBit = slot.rank != null ? ` · #${slot.rank}` : " · —";
  const deltaBit = slot.delta != null ? ` (${formatSignedDelta(slot.delta)})` : "";
  const winnerBit = slot.winner ? " · family winner" : "";
  const themeBit = slot.theme ? ` (${slot.theme})` : "";
  return `Child ${slot.asin}${themeBit}${rankBit}${deltaBit}${winnerBit}`;
}

export function sortVariationSlots(
  slots: VariationDaySlot[],
  winnerAsin?: string | null,
): VariationDaySlot[] {
  const winner = asOrganicChild(winnerAsin);
  return [...slots].sort((a, b) => {
    if (winner) {
      if (a.asin === winner && b.asin !== winner) return -1;
      if (b.asin === winner && a.asin !== winner) return 1;
    }
    const left = asRank(a.rank);
    const right = asRank(b.rank);
    if (left != null && right != null && left !== right) return left - right;
    if (left != null && right == null) return -1;
    if (left == null && right != null) return 1;
    return a.asin.localeCompare(b.asin);
  });
}

/**
 * Compact chips for one keyword×day. Δ vs the prior day's slot for that ASIN
 * when both ranks exist. Missing children are omitted — never fabricated.
 */
export function variationChipsForDay(
  row: Pick<HeatmapRow, "variation_slots" | "organic_child_asins" | "organic_child_asin">,
  week: string,
  weeks: string[],
): VariationChip[] {
  const slots = sortVariationSlots(
    row.variation_slots[week] ?? [],
    row.organic_child_asins[week] ?? row.organic_child_asin,
  );
  const idx = weeks.indexOf(week);
  const priorWeek = idx > 0 ? weeks[idx - 1] : null;
  const priorByAsin = new Map(
    (priorWeek ? row.variation_slots[priorWeek] ?? [] : []).map((s) => [s.asin, s]),
  );
  const winner = asOrganicChild(row.organic_child_asins[week] ?? row.organic_child_asin);
  return slots.map((slot) => {
    const prior = priorByAsin.get(slot.asin);
    return {
      asin: slot.asin,
      theme: variationThemeLabel(slot.theme),
      label: shortVariationLabel(slot.asin, slot.theme),
      rank: asRank(slot.rank),
      delta: rankDelta(prior?.rank, slot.rank),
      amazon_choice: slot.amazon_choice,
      winner: winner != null && slot.asin === winner,
    };
  });
}

export type ChildLegendItem = {
  asin: string;
  label: string;
};

export function rowHasThemeCatalog(
  row: Pick<HeatmapRow, "variation_slots">,
): boolean {
  return Object.values(row.variation_slots ?? {}).some((slots) =>
    slots.some((s) => Boolean(variationThemeLabel(s.theme))),
  );
}

/**
 * Theme (or last-4 fallback) for the child that holds the heatmap cell.
 * Never returns a rank — the cell primary # is the Rank Tracker day rank.
 */
export function winnerChildLabel(
  row: Pick<HeatmapRow, "variation_slots" | "organic_child_asins">,
  week: string,
): string | null {
  const winner = asOrganicChild(row.organic_child_asins[week]);
  if (!winner) return null;
  const dayHit = (row.variation_slots[week] ?? []).find((s) => s.asin === winner);
  const dayTheme = variationThemeLabel(dayHit?.theme);
  if (dayTheme) return dayTheme;
  for (const slots of Object.values(row.variation_slots ?? {})) {
    const hit = slots.find((s) => s.asin === winner);
    const theme = variationThemeLabel(hit?.theme);
    if (theme) return theme;
  }
  return rowHasThemeCatalog(row) ? null : shortOrganicChild(winner) || null;
}

/**
 * Unique children that appear on the row, theme-preferred, no ranks.
 * Used as a compact keyword-column legend — never an ASIN+theme pair.
 */
export function keywordChildLegend(
  row: Pick<HeatmapRow, "variation_slots" | "organic_child_asins">,
): ChildLegendItem[] {
  const byAsin = new Map<string, string | null>();
  for (const slots of Object.values(row.variation_slots ?? {})) {
    for (const slot of slots) {
      const asin = asOrganicChild(slot.asin);
      if (!asin) continue;
      const theme = variationThemeLabel(slot.theme);
      const prev = byAsin.get(asin);
      if (!byAsin.has(asin) || (!prev && theme)) byAsin.set(asin, theme);
    }
  }
  for (const child of Object.values(row.organic_child_asins ?? {})) {
    const asin = asOrganicChild(child);
    if (asin && !byAsin.has(asin)) byAsin.set(asin, null);
  }
  return [...byAsin.entries()]
    .map(([asin, theme]) => ({
      asin,
      label: theme || shortOrganicChild(asin),
    }))
    .filter((item) => item.label)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Child variation rank 1–10 must always appear as theme+#N in the day cell. */
export function isTopTenOrganic(rank: number | null | undefined): boolean {
  const n = asRank(rank);
  return n != null && n <= 10;
}

/**
 * Organic cell for one keyword × day.
 *
 * SoT is the best stored rank (lowest organic position) among the
 * phrases/v2 snapshot and every tracked child. Rank 0 / missing is not
 * a rank and is never invented.
 * When a tracked child beats phrases/v2, the cell number, winner theme,
 * and heat fill are that child. phrases/v2 remains when it is better
 * than every stored child, or when no child rank was stored.
 * A tie with phrases/v2 keeps the phrases/v2 organic asin (and its
 * theme). Otherwise the lowest ASIN among children at the best rank.
 */
export function selectOrganicCell(args: {
  phraseRank?: number | null;
  phraseAsin?: string | null;
  phraseChoice?: boolean | null;
  slots?: VariationDaySlot[] | null;
}): { rank: number | null; asin: string | null; amazonChoice: boolean | null } {
  const phraseRank = asRank(args.phraseRank);
  const phraseAsin = asOrganicChild(args.phraseAsin);
  const phraseChoice = typeof args.phraseChoice === "boolean" ? args.phraseChoice : null;
  const ranked = (args.slots ?? [])
    .map((slot) => ({
      asin: asOrganicChild(slot.asin),
      rank: asRank(slot.rank),
      amazon_choice: typeof slot.amazon_choice === "boolean" ? slot.amazon_choice : null,
    }))
    .filter((slot): slot is { asin: string; rank: number; amazon_choice: boolean | null } => (
      slot.asin != null && slot.rank != null
    ));
  const childRanks = ranked.map((slot) => slot.rank);
  const phraseBeatsChildren = phraseRank != null && childRanks.every((rank) => phraseRank < rank);
  const bestRank = phraseBeatsChildren || childRanks.length === 0
    ? phraseRank
    : Math.min(...(phraseRank == null ? childRanks : [phraseRank, ...childRanks]));
  if (bestRank == null) {
    return { rank: null, asin: phraseAsin, amazonChoice: phraseChoice };
  }
  // phrases/v2 shares the best stored number: keep its ASIN. Theme still
  // resolves from the matching variation slot when one exists.
  if (phraseRank != null && phraseRank === bestRank && phraseAsin) {
    const same = ranked.find((slot) => slot.asin === phraseAsin);
    return {
      rank: bestRank,
      asin: phraseAsin,
      amazonChoice: same?.amazon_choice ?? phraseChoice,
    };
  }
  const holders = ranked
    .filter((slot) => slot.rank === bestRank)
    .sort((a, b) => a.asin.localeCompare(b.asin));
  const winner = holders[0];
  if (!winner) {
    return { rank: bestRank, asin: phraseAsin, amazonChoice: phraseChoice };
  }
  return {
    rank: bestRank,
    asin: winner.asin,
    amazonChoice: winner.amazon_choice ?? phraseChoice,
  };
}

/**
 * Extra day-cell chips: one identity and one rank per child ASIN.
 *
 * The cell number / fill / sort / spark is `selectOrganicCell` (best
 * stored rank). A child who owns that number is not chipped again.
 *   - Variation snapshot rank is the chip rank. Theme labels the child
 *     (never an ASIN CHILD pill + theme for the same ASIN).
 *   - Other children with a stored variation rank are chipped.
 *   - Winner is omitted when their variation rank is missing, >10, or
 *     already equal to the cell number.
 *   - A winner whose variation rank is 1–10 and differs from the cell
 *     is always listed as theme+#N.
 */
export function heatmapDayChips(
  row: Pick<HeatmapRow, "variation_slots" | "organic_child_asins" | "organic_child_asin" | "positions">,
  week: string,
  weeks: string[],
): VariationChip[] {
  const winner = asOrganicChild(row.organic_child_asins[week]);
  const familyRank = asRank(row.positions?.[week]);
  const seen = new Set<string>();
  const out: VariationChip[] = [];
  for (const chip of variationChipsForDay(row, week, weeks)) {
    if (seen.has(chip.asin)) continue;
    seen.add(chip.asin);
    if (chip.rank == null) continue;
    const topTen = isTopTenOrganic(chip.rank);
    if (winner && chip.asin === winner) {
      if (!topTen) continue;
      if (familyRank != null && familyRank === chip.rank) continue;
    }
    out.push(chip);
  }
  return out;
}

export function latestOrganicChild(
  asins: Record<string, string | null | undefined> | null | undefined,
  weeks: string[],
): string | null {
  if (!asins) return null;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const hit = asOrganicChild(asins[weeks[i]]);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rank for the CHILD pill in the Keyword column.
 *
 * Warehouse stores one organic_asin per hero×phrase×day. That slot’s rank
 * is HeatmapRow.current — never a sibling array. Missing current stays
 * null (pill still renders; rank is omitted). Δ only when both sides exist.
 */
export type ChildSlotRank = {
  asin: string;
  rank: number | null;
  delta: number | null;
};

export function childSlotRank(
  row: Pick<HeatmapRow, "organic_child_asin" | "current" | "previous">,
): ChildSlotRank | null {
  const asin = asOrganicChild(row.organic_child_asin);
  if (!asin) return null;
  return {
    asin,
    rank: asRank(row.current),
    delta: rankDelta(row.previous, row.current),
  };
}

/** Keyword-column rank: blank when missing — never an em-dash placeholder. */
export function formatChildSlotRank(rank: number | null | undefined): string {
  const r = asRank(rank);
  return r == null ? "" : `#${r}`;
}

export function childSlotHoverTitle(slot: ChildSlotRank): string {
  const rankBit = slot.rank != null ? ` · #${slot.rank}` : "";
  const deltaBit = slot.delta != null ? ` (${formatSignedDelta(slot.delta)})` : "";
  return `Child ASIN holding the latest organic rank: ${slot.asin}${rankBit}${deltaBit}`;
}

export function cellHoverTitle(args: {
  previous: number | null | undefined;
  current: number | null | undefined;
  sfr?: number | null;
  organicAsin?: string | null;
  amazonChoice?: boolean | null;
}): string {
  const prev = asRank(args.previous);
  const cur = asRank(args.current);
  const delta = rankDelta(prev, cur);
  const left = prev == null ? "—" : String(prev);
  const right = cur == null ? "—" : String(cur);
  const move = delta == null ? "" : ` (${formatSignedDelta(delta)})`;
  const sfr = args.sfr === undefined ? "" : ` · SFR ${formatSfr(args.sfr)}`;
  const child = asOrganicChild(args.organicAsin);
  const childBit = child ? ` · child ${child}` : "";
  const choice = args.amazonChoice === true ? " · Amazon's Choice" : "";
  return `${left} → ${right}${move}${sfr}${childBit}${choice}`;
}

/**
 * Prior rank for a cell: previous week column when the grid has ≥2 weeks,
 * else SoldScope organic_previous_position (row.previous).
 */
export function cellPriorRank(
  row: Pick<HeatmapRow, "positions" | "previous">,
  week: string,
  weeks: string[],
): number | null {
  const idx = weeks.indexOf(week);
  if (idx > 0) return asRank(row.positions[weeks[idx - 1]]);
  if (weeks.length === 1) return asRank(row.previous);
  return null;
}

/** Chronological ranks for the sparkline. One week → prior→current. */
export function sparklineSeries(
  row: Pick<HeatmapRow, "positions" | "previous" | "current">,
  weeks: string[],
): Array<number | null> {
  if (weeks.length >= 2) {
    return weeks.map((w) => asRank(row.positions[w]));
  }
  if (row.previous != null || row.current != null) {
    return [asRank(row.previous), asRank(row.current)];
  }
  return [];
}

export function sparklineGeometry(
  values: Array<number | null>,
  opts?: { width?: number; height?: number; pad?: number },
): { points: SparkPoint[]; polyline: string; direction: MoveDirection } {
  const width = opts?.width ?? 56;
  const height = opts?.height ?? 18;
  const pad = opts?.pad ?? 2.5;
  const indexed = values
    .map((v, i) => ({ i, v: asRank(v) }))
    .filter((p): p is { i: number; v: number } => p.v != null);
  if (indexed.length === 0) {
    return { points: [], polyline: "", direction: "unknown" };
  }
  const nums = indexed.map((p) => p.v);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const n = Math.max(values.length - 1, 1);
  const yFor = (v: number) => (
    hi === lo ? height / 2 : pad + ((v - lo) / (hi - lo)) * (height - pad * 2)
  );
  const points = indexed.map(({ i, v }) => ({
    x: pad + (i * (width - pad * 2)) / n,
    y: yFor(v),
    v,
  }));
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const first = nums[0];
  const last = nums[nums.length - 1];
  const direction: MoveDirection =
    last < first ? "improved" : last > first ? "worsened" : "unchanged";
  return { points, polyline, direction };
}

function keywordTie(a: HeatmapRow, b: HeatmapRow): number {
  return a.keyword_normalized.localeCompare(b.keyword_normalized);
}

/**
 * Compare two optional ranks / SFR values.
 * Null / missing always sort last (after every finite value), regardless of
 * `dir`. Amazon rank and ABA SFR: lower number is better / more frequent.
 * Returns 0 when both are null or equal so the caller can tie-break.
 */
function compareNullableRank(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: HeatmapSortDir,
): number {
  const left = asRank(a);
  const right = asRank(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left === right) return 0;
  return dir === "asc" ? left - right : right - left;
}

export function parseHeatmapSort(sort: HeatmapSortKey | HeatmapSortSpec): HeatmapSortSpec {
  if (typeof sort === "string") return { key: sort, dir: "asc" };
  return {
    key: sort.key,
    dir: sort.dir === "desc" ? "desc" : "asc",
    week: sort.week,
  };
}

/**
 * Header click cycle: new column → asc → desc → default SFR asc.
 * Asc on rank/SFR is lower-number first (better rank / more frequent).
 */
export function cycleHeatmapSort(
  current: HeatmapSortKey | HeatmapSortSpec,
  next: { key: HeatmapSortKey | "week"; week?: string },
): HeatmapSortSpec {
  const cur = parseHeatmapSort(current);
  const same = cur.key === next.key && (next.key !== "week" || cur.week === next.week);
  if (!same) return { key: next.key, dir: "asc", week: next.week };
  if (cur.dir === "asc") return { key: next.key, dir: "desc", week: next.week };
  return { ...DEFAULT_HEATMAP_SORT };
}

export function heatmapSortCaption(sort: HeatmapSortKey | HeatmapSortSpec): string {
  const spec = parseHeatmapSort(sort);
  if (spec.key === "keyword") {
    return spec.dir === "asc" ? "sorted A–Z" : "sorted Z–A";
  }
  if (spec.key === "rank") {
    return spec.dir === "asc"
      ? "sorted by current rank (best / #1 first)"
      : "sorted by current rank (worst first)";
  }
  if (spec.key === "week") {
    const day = spec.week ?? "day";
    return spec.dir === "asc"
      ? `sorted by ${day} (best / #1 first)`
      : `sorted by ${day} (worst first)`;
  }
  if (spec.key === "moved") {
    return spec.dir === "asc" ? "movers first" : "still first";
  }
  return spec.dir === "asc"
    ? "sorted by SFR (more frequent first)"
    : "sorted by SFR (less frequent first)";
}

export function sortHeatmapRows(
  rows: HeatmapRow[],
  sort: HeatmapSortKey | HeatmapSortSpec,
): HeatmapRow[] {
  const spec = parseHeatmapSort(sort);
  const copy = [...rows];
  const sign = spec.dir === "asc" ? 1 : -1;
  if (spec.key === "keyword") {
    return copy.sort((a, b) => {
      const primary = keywordTie(a, b) * sign;
      return primary !== 0 ? primary : keywordTie(a, b);
    });
  }
  if (spec.key === "rank") {
    return copy.sort((a, b) => {
      const primary = compareNullableRank(a.current, b.current, spec.dir);
      return primary !== 0 ? primary : keywordTie(a, b);
    });
  }
  if (spec.key === "week") {
    const week = spec.week ?? "";
    return copy.sort((a, b) => {
      const primary = compareNullableRank(a.positions[week], b.positions[week], spec.dir);
      return primary !== 0 ? primary : keywordTie(a, b);
    });
  }
  if (spec.key === "moved") {
    return copy.sort((a, b) => {
      const am = classifyMovement(a.previous, a.current);
      const bm = classifyMovement(b.previous, b.current);
      const as = am.meaningful ? 2 : am.anyMove ? 1 : 0;
      const bs = bm.meaningful ? 2 : bm.anyMove ? 1 : 0;
      if (as !== bs) return (bs - as) * sign;
      const ad = Math.abs(am.delta ?? 0);
      const bd = Math.abs(bm.delta ?? 0);
      if (ad !== bd) return (bd - ad) * sign;
      const sfr = compareNullableRank(a.sfr, b.sfr, "asc");
      return sfr !== 0 ? sfr : keywordTie(a, b);
    });
  }
  return copy.sort((a, b) => {
    const primary = compareNullableRank(a.sfr, b.sfr, spec.dir);
    return primary !== 0 ? primary : keywordTie(a, b);
  });
}

/** Brand Analytics SFR only. searchVolume is never a substitute. */
export function resolveSfr(
  snapshotSfr: number | null | undefined,
): { sfr: number | null; source: "aba" | null } {
  const sfr = asRank(snapshotSfr);
  return sfr == null ? { sfr: null, source: null } : { sfr, source: "aba" };
}

export function rankHeatTone(rank: number | null | undefined): string {
  const n = asRank(rank);
  if (n == null) return "missing";
  if (n <= 3) return "best";
  if (n <= 10) return "strong";
  if (n <= 20) return "good";
  if (n <= 50) return "mid";
  if (n <= 100) return "weak";
  return "poor";
}

function newerDate(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!b) return false;
  if (!a) return true;
  return String(b) > String(a);
}

function latestByKey<T>(
  rows: T[],
  keyOf: (row: T) => string,
  dateOf: (row: T) => string | null | undefined,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const cur = out.get(key);
    if (!cur || newerDate(dateOf(cur), dateOf(row))) out.set(key, row);
  }
  return out;
}

export function buildOrganicRankProgress(input: {
  snapshots: RankSnapshot[];
  variationSnapshots?: VariationSnapshot[];
  sqpRows?: SqpJoinRow[];
  korRows?: KorJoinRow[];
  weekCap?: number;
}): OrganicRankProgress {
  const weekCap = input.weekCap ?? HEATMAP_WEEK_CAP;
  const locked = new Set<string>(HERO_ASINS);
  const weeks = [...new Set(
    input.snapshots
      .map((r) => String(r.as_of ?? "").slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  )].sort();
  const shownWeeks = weeks.slice(-weekCap);

  const sqp = latestByKey(
    input.sqpRows ?? [],
    (r) => `${String(r.asin ?? "").toUpperCase()}|${normalizeKeyword(r.query_normalized)}`,
    (r) => r.week_start,
  );
  const kor = latestByKey(
    input.korRows ?? [],
    (r) => `${String(r.asin ?? "").toUpperCase()}|${normalizeKeyword(r.keyword_normalized)}`,
    (r) => r.as_of,
  );

  type Series = {
    keyword: string;
    keyword_normalized: string;
    asin: string;
    family: HeroFamily;
    sfr: number | null;
    sfr_as_of: string | null;
    positions: Record<string, number | null>;
    organic_child_asins: Record<string, string | null>;
    amazon_choices: Record<string, boolean | null>;
    variation_slots: Record<string, VariationDaySlot[]>;
    previous_from_api: number | null;
  };
  const series = new Map<string, Series>();

  const dated = [...input.snapshots].sort((a, b) =>
    String(a.as_of ?? "").localeCompare(String(b.as_of ?? "")),
  );
  for (const row of dated) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!locked.has(asin)) continue;
    const family = familyOfAsin(asin);
    if (!family) continue;
    const phrase = String(row.phrase ?? "").trim();
    const keyNorm = normalizeKeyword(phrase);
    if (!keyNorm) continue;
    const asOf = String(row.as_of ?? "").slice(0, 10);
    const seriesKey = `${asin}|${keyNorm}`;
    const cur = series.get(seriesKey) ?? {
      keyword: phrase,
      keyword_normalized: keyNorm,
      asin,
      family,
      sfr: null,
      sfr_as_of: null,
      positions: {},
      organic_child_asins: {},
      amazon_choices: {},
      variation_slots: {},
      previous_from_api: null,
    };
    if (shownWeeks.includes(asOf)) {
      cur.positions[asOf] = asRank(row.organic_position);
      const child = asOrganicChild(row.organic_asin);
      if (child) cur.organic_child_asins[asOf] = child;
      if (typeof row.amazon_choice === "boolean") {
        cur.amazon_choices[asOf] = row.amazon_choice;
      }
    }
    const sfrHit = resolveSfr(row.aba_search_frequency_rank);
    if (sfrHit.sfr != null && newerDate(cur.sfr_as_of, asOf)) {
      cur.sfr = sfrHit.sfr;
      cur.sfr_as_of = asOf;
    }
    if (asOf === shownWeeks[shownWeeks.length - 1] || shownWeeks.length === 0) {
      cur.previous_from_api = asRank(row.organic_previous_position);
    }
    series.set(seriesKey, cur);
  }

  const datedVariations = [...(input.variationSnapshots ?? [])].sort((a, b) =>
    String(a.as_of ?? "").localeCompare(String(b.as_of ?? "")),
  );
  for (const row of datedVariations) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!locked.has(asin)) continue;
    const phrase = String(row.phrase ?? "").trim();
    const keyNorm = normalizeKeyword(phrase);
    if (!keyNorm) continue;
    const cur = series.get(`${asin}|${keyNorm}`);
    if (!cur) continue;
    const asOf = String(row.as_of ?? "").slice(0, 10);
    if (!shownWeeks.includes(asOf)) continue;
    const child = asOrganicChild(row.variation_asin);
    if (!child) continue;
    const rank = asRank(row.organic_position);
    if (rank == null) continue;
    const slots = cur.variation_slots[asOf] ?? [];
    if (slots.some((s) => s.asin === child)) continue;
    slots.push({
      asin: child,
      theme: variationThemeLabel(row.theme),
      rank,
      amazon_choice: typeof row.amazon_choice === "boolean" ? row.amazon_choice : null,
    });
    cur.variation_slots[asOf] = slots;
  }

  // Cell = best stored rank. A child that beats phrases/v2 owns the
  // number, the theme, and therefore the heat fill.
  for (const cur of series.values()) {
    for (const asOf of shownWeeks) {
      const picked = selectOrganicCell({
        phraseRank: cur.positions[asOf],
        phraseAsin: cur.organic_child_asins[asOf],
        phraseChoice: cur.amazon_choices[asOf],
        slots: cur.variation_slots[asOf] ?? [],
      });
      cur.positions[asOf] = picked.rank;
      cur.organic_child_asins[asOf] = picked.asin;
      if (picked.amazonChoice != null) cur.amazon_choices[asOf] = picked.amazonChoice;
    }
  }

  const lastWeek = shownWeeks[shownWeeks.length - 1] ?? null;
  const priorWeek = shownWeeks.length >= 2 ? shownWeeks[shownWeeks.length - 2] : null;

  const rows: HeatmapRow[] = [...series.values()].map((s) => {
    const current = lastWeek ? asRank(s.positions[lastWeek]) : null;
    const fromHistory = priorWeek ? asRank(s.positions[priorWeek]) : null;
    const previous = fromHistory ?? s.previous_from_api;
    const sqpRow = sqp.get(`${s.asin}|${s.keyword_normalized}`);
    const korRow = kor.get(`${s.asin}|${s.keyword_normalized}`);
    return {
      keyword: s.keyword,
      keyword_normalized: s.keyword_normalized,
      asin: s.asin,
      family: s.family.id,
      sfr: s.sfr,
      sfr_source: s.sfr == null ? null : "aba",
      sqp_click_share: sqpRow?.click_share ?? null,
      sqp_organic_rank: asRank(korRow?.organic_rank),
      positions: Object.fromEntries(shownWeeks.map((w) => [w, s.positions[w] ?? null])),
      organic_child_asins: Object.fromEntries(
        shownWeeks.map((w) => [w, asOrganicChild(s.organic_child_asins[w])]),
      ),
      amazon_choices: Object.fromEntries(
        shownWeeks.map((w) => [w, s.amazon_choices[w] ?? null]),
      ),
      organic_child_asin: latestOrganicChild(s.organic_child_asins, shownWeeks),
      variation_slots: Object.fromEntries(
        shownWeeks.map((w) => [w, sortVariationSlots(
          s.variation_slots[w] ?? [],
          asOrganicChild(s.organic_child_asins[w]),
        )]),
      ),
      previous,
      current,
      wow: classifyWowDelta(previous, current),
    };
  });

  rows.sort((a, b) => {
    if (a.sfr != null && b.sfr != null && a.sfr !== b.sfr) return a.sfr - b.sfr;
    if (a.sfr != null && b.sfr == null) return -1;
    if (a.sfr == null && b.sfr != null) return 1;
    return a.keyword_normalized.localeCompare(b.keyword_normalized);
  });

  const movers = rows
    .filter((r) => r.wow)
    .sort((a, b) => {
      if (a.wow!.direction !== b.wow!.direction) {
        return a.wow!.direction === "improved" ? -1 : 1;
      }
      const ad = Math.abs(a.wow!.delta ?? 0);
      const bd = Math.abs(b.wow!.delta ?? 0);
      return bd - ad;
    });

  const familyStats = HERO_FAMILIES.map((f) => {
    const mine = rows.filter((r) => r.family === f.id);
    const weekSet = new Set<string>();
    for (const r of mine) {
      for (const [w, pos] of Object.entries(r.positions)) {
        if (pos != null) weekSet.add(w);
      }
    }
    return { ...f, phrases: mine.length, weeks: weekSet.size };
  });

  return {
    empty: rows.length === 0,
    emptyCopy: RANK_EMPTY_COPY,
    families: familyStats,
    weeks: shownWeeks,
    rows,
    movers,
    thresholds: { movePositions: WOW_MOVE_POSITIONS, topN: WOW_TOP_N },
    baselineOnly: rows.length > 0 && shownWeeks.length === 1,
  };
}

export function filterProgress(
  progress: OrganicRankProgress,
  family: HeroFamilyId | "all",
): OrganicRankProgress {
  if (family === "all") return progress;
  const rows = progress.rows.filter((r) => r.family === family);
  const movers = progress.movers.filter((r) => r.family === family);
  const empty = rows.length === 0;
  return {
    ...progress,
    empty,
    emptyCopy: empty ? emptyCopyForFamily(family) : progress.emptyCopy,
    rows,
    movers,
    baselineOnly: rows.length > 0 && progress.weeks.length === 1,
  };
}

export function formatRank(n: number | null | undefined): string {
  const r = asRank(n);
  return r == null ? "—" : String(r);
}

export function formatSfr(n: number | null | undefined): string {
  const r = asRank(n);
  return r == null ? "—" : r.toLocaleString();
}

export function wowLabel(flag: WowFlag | null): string {
  if (!flag) return "";
  if (flag.reason === "entered_top_n") return `Entered top ${WOW_TOP_N}`;
  if (flag.reason === "exited_top_n") return `Fell out of top ${WOW_TOP_N}`;
  const n = Math.abs(flag.delta ?? 0);
  return flag.direction === "improved"
    ? `Up ${n} position${n === 1 ? "" : "s"}`
    : `Down ${n} position${n === 1 ? "" : "s"}`;
}

/** GNO pack columns — rank/SFR only. Never invent from SoldScope searchVolume. */
export const ORGANIC_RANK_EXPORT_HEADERS = [
  "organic_rank", "organic_rank_prev", "organic_rank_delta", "aba_sfr", "organic_as_of",
] as const;

export const ORGANIC_RANK_SNAPSHOT_CSV_HEADERS = [
  "keyword", "asin", "family", "aba_sfr",
  "organic_rank", "organic_rank_prev", "organic_rank_delta", "organic_as_of",
] as const;

export const ORGANIC_RANK_EMPTY_CELL_NOTE =
  "Empty organic_rank / aba_sfr cells are missing SoldScope / Brand Analytics values — not zero, and never invented from searchVolume.";

export type OrganicRankJoin = {
  organic_rank: number | null;
  organic_rank_prev: number | null;
  organic_rank_delta: number | null;
  aba_sfr: number | null;
  organic_as_of: string | null;
  organic_asin: string | null;
  organic_family: string | null;
};

export function emptyOrganicRankJoin(): OrganicRankJoin {
  return {
    organic_rank: null,
    organic_rank_prev: null,
    organic_rank_delta: null,
    aba_sfr: null,
    organic_as_of: null,
    organic_asin: null,
    organic_family: null,
  };
}

/** Hero ASIN for a GNO / heatmap family. Unknown family → no preference. */
export function familyHeroAsin(family: string | null | undefined): string | undefined {
  const f = String(family ?? "").trim().toLowerCase();
  if (f === "lip" || f === "lip_3pk") return "B0CLHTF8YN";
  if (f === "balm") return "B0DQFKMJFY";
  if (f === "deo") return "B0HBSZ71XQ";
  return undefined;
}

export type OrganicRankSnapshotRow = {
  keyword: string;
  asin: string;
  family: HeroFamilyId;
  aba_sfr: number | null;
  organic_rank: number | null;
  organic_rank_prev: number | null;
  organic_rank_delta: number | null;
  organic_as_of: string | null;
};

/**
 * Latest SoldScope snapshot per (hero ASIN, normalized phrase).
 * SFR is ABA only (`aba_search_frequency_rank`). searchVolume is ignored.
 */
export function buildOrganicRankJoinIndex(snapshots: RankSnapshot[]): Map<string, OrganicRankJoin[]> {
  const progress = buildOrganicRankProgress({ snapshots });
  const asOf = progress.weeks[progress.weeks.length - 1] ?? null;
  const byKw = new Map<string, OrganicRankJoin[]>();
  for (const row of progress.rows) {
    const hit: OrganicRankJoin = {
      organic_rank: row.current,
      organic_rank_prev: row.previous,
      organic_rank_delta: rankDelta(row.previous, row.current),
      aba_sfr: row.sfr,
      organic_as_of: asOf,
      organic_asin: row.asin,
      organic_family: row.family,
    };
    const list = byKw.get(row.keyword_normalized) ?? [];
    list.push(hit);
    byKw.set(row.keyword_normalized, list);
  }
  return byKw;
}

export function lookupOrganicRank(
  index: Map<string, OrganicRankJoin[]>,
  keyword: string | null | undefined,
  preferAsin?: string | null,
): OrganicRankJoin {
  const key = normalizeKeyword(keyword);
  const hits = key ? index.get(key) ?? [] : [];
  if (!hits.length) return emptyOrganicRankJoin();
  const prefer = String(preferAsin ?? "").trim().toUpperCase();
  if (prefer) {
    const preferred = hits.find((h) => String(h.organic_asin ?? "").toUpperCase() === prefer);
    if (preferred) return preferred;
  }
  return hits[0];
}

export function organicRankSnapshotRows(snapshots: RankSnapshot[]): OrganicRankSnapshotRow[] {
  const progress = buildOrganicRankProgress({ snapshots });
  const asOf = progress.weeks[progress.weeks.length - 1] ?? null;
  return progress.rows.map((row) => ({
    keyword: row.keyword,
    asin: row.asin,
    family: row.family,
    aba_sfr: row.sfr,
    organic_rank: row.current,
    organic_rank_prev: row.previous,
    organic_rank_delta: rankDelta(row.previous, row.current),
    organic_as_of: asOf,
  }));
}
