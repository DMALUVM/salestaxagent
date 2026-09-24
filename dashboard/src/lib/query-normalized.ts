/**
 * Join key for search terms, Exact keywords, SQP, SoldScope, KR, and negatives.
 *
 * lowercase, trim, collapse whitespace, ASCII-fold.
 * Fold women → woman so the two spellings join. man/men are not folded.
 */

const BRAND_CONQUEST_RE =
  /\b(native|medicube|dr\.?\s*squatch|harry'?s|dove|degree|old spice|secret|schmidt'?s)\b/i;

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
