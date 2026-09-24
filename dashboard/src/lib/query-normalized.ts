/**
 * Join key for search terms, Exact keywords, SQP, SoldScope, KR, and negatives.
 *
 * lowercase, trim, collapse whitespace, ASCII-fold.
 * Fold women → woman so the two spellings join. man/men are not folded.
 */

/**
 * Competitor brand SERP names. `allow` / harvest-ok is for category terms
 * (beef tallow, tallow balm), not these brands.
 * Named 2026-09-24: lume, donna karan, primally pure, osea, vanicream, saltair,
 * plus the brands already on this list (native, medicube, and the rest).
 */
const BRAND_CONQUEST_RE =
  /\b(?:native|medicube|lume|osea|vanicream|saltair|donna\s+karan|primally\s+pure|dr\.?\s*squatch|harry'?s|dove|degree|old\s+spice|secret|schmidt'?s)\b/i;

export function queryNormalized(term: string | null | undefined): string {
  return String(term ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\bwomen\b/g, "woman");
}

/** Competitor brand names. Never an auto harvest_exact. */
export function isBrandConquest(term: string | null | undefined): boolean {
  const q = queryNormalized(term);
  return q.length > 0 && BRAND_CONQUEST_RE.test(q);
}

/** Body butter vs tallow balm is a soft family fit, not an allow harvest. */
export function isSoftBodyButter(term: string | null | undefined): boolean {
  return /\bbody butter\b/.test(queryNormalized(term));
}
