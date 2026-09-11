/**
 * Weekly organic-rank progress for hero ASINs.
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
  "No weekly organic-rank snapshots yet. The Sunday SoldScope job stores phrases when a Rank Tracker group exists. Empty is real — this is not a sales or ads number, and this desk never creates Rank Tracker groups.";

export const DEO_EMPTY_COPY =
  "Deodorant is not in Rank Tracker yet. No rows invented — add a SoldScope RT group for B0HBSZ71XQ when you are ready. This desk never creates groups or phrases.";

export const FAMILY_EMPTY_COPY =
  "No Rank Tracker snapshots for this hero yet. Empty is real — nothing invented, and no group is created from this desk.";

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
  aba_search_frequency_rank?: number | null;
  aba_total_click_share?: number | null;
  aba_total_conv_share?: number | null;
  search_volume?: number | null;
  as_of?: string | null;
  group_id?: number | null;
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
};

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
      previous_from_api: null,
    };
    if (shownWeeks.includes(asOf)) {
      cur.positions[asOf] = asRank(row.organic_position);
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
  };
}

export function filterProgress(
  progress: OrganicRankProgress,
  family: HeroFamilyId | "all",
): OrganicRankProgress {
  if (family === "all") return progress;
  const rows = progress.rows.filter((r) => r.family === family);
  const movers = progress.movers.filter((r) => r.family === family);
  return {
    ...progress,
    empty: rows.length === 0,
    emptyCopy: emptyCopyForFamily(family),
    rows,
    movers,
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
