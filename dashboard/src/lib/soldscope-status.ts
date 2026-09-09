/**
 * SoldScope research status — additive warehouse freshness only.
 *
 * Not a Pulse / Ads / sales_daily source. The Dashboard must not grow a
 * second sales or BSR chart from these tables. Empty is a real state
 * (SoldScope still syncing Dave's catalog, or first weekly job not run).
 */
import bundled from "../../config/soldscope.json";
import bundledTitles from "../../config/asin_titles.json";

export const SOLDSCOPE_OBSERVE_ONLY = true;

export const HERO_ASINS = [
  "B0CLHTF8YN",
  "B0DQFKMJFY",
  "B0HBSZ71XQ",
] as const;

export const EMPTY_STATE_COPY =
  "No SoldScope history yet. The account may still be downloading Amazon data, or the Sunday weekly job has not run. This is not a sales or ads number.";

export const RT_EMPTY_COPY =
  "Rank Tracker: 0 matching groups — observe-only, nothing created.";

export type SoldScopeHero = { asin: string; title: string };

export function heroList(
  rawAsins: unknown = (bundled as { asins?: string[] }).asins,
  titles: Record<string, unknown> = bundledTitles as Record<string, unknown>,
): SoldScopeHero[] {
  const locked = new Set<string>(HERO_ASINS);
  const requested = (Array.isArray(rawAsins) ? rawAsins : [])
    .map((a) => String(a).trim().toUpperCase())
    .filter((a) => locked.has(a));
  const asins = requested.length ? requested : [...HERO_ASINS];
  return asins.map((asin) => {
    const title = titles[asin];
    return {
      asin,
      title: typeof title === "string" && title.trim() ? title.trim() : asin,
    };
  });
}

export function summarizeFreshness(args: {
  salesRows: number;
  bsrRows: number;
  priceRows: number;
  rankRows: number;
  newestDate: string | null;
}): { empty: boolean; newestDate: string | null; stored: boolean } {
  const stored = args.salesRows + args.bsrRows + args.priceRows + args.rankRows > 0;
  return {
    empty: !stored,
    newestDate: args.newestDate,
    stored,
  };
}
