/**
 * Brand rewriter for product display titles.
 *
 * Canonical brand: Tallowbourn. Old Amazon listings may still use legacy
 * brand forms which must never appear in the dashboard UI.
 */

const BRAND = "Tallowbourn";

// Ordered from longest to shortest to avoid partial matches.
// Each pattern is case-insensitive and accounts for curly/straight quotes.
const BRAND_PATTERNS: [RegExp, string][] = [
  // Full legacy brand: "Dr. Dave's Primal Essence" (all apostrophe variants)
  [/Dr\.?\s*Dave[''\u2019]?s?\s+Primal\s+Essence\s*/gi, `${BRAND} `],
  // "Primal Essence" as standalone brand phrase (not inside another word)
  [/\bPrimal\s+Essence\s*/gi, `${BRAND} `],
  // Leading "Dr. Dave's" (with or without period/apostrophe)
  [/^Dr\.?\s*Dave[''\u2019]?s?\s*/gi, `${BRAND} `],
];

function rewriteBrand(title: string): string {
  let out = title;
  for (const [pattern, replacement] of BRAND_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Clean up double spaces / leading/trailing whitespace
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Rewrite the brand name in a product title for display.
 *
 * Prefers shopifyTitle when available (already uses Tallowbourn).
 * Falls back to amazonTitle with brand replacement.
 *
 * Returns "Untitled" if both inputs are empty/null.
 */
export function displayTitle(
  amazonTitle?: string | null,
  shopifyTitle?: string | null,
): string {
  if (shopifyTitle?.trim()) return rewriteBrand(shopifyTitle.trim());
  if (amazonTitle?.trim()) return rewriteBrand(amazonTitle.trim());
  return "Untitled";
}

/**
 * Return the raw Amazon title without brand rewriting.
 *
 * Useful when you need the original title for search/matching against
 * Amazon APIs.  Returns empty string if null/undefined.
 */
export function rawTitle(amazonTitle?: string | null): string {
  if (!amazonTitle) return "";
  return amazonTitle.trim();
}
