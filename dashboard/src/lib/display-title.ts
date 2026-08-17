/**
 * Brand rewriter for product display titles.
 *
 * Amazon listings use the legal brand name "Dr. Dave's Primal Essence"
 * but the dashboard should display "Tallowbourn" consistently.
 */

const BRAND_NEW = "Tallowbourn";

// Case-insensitive pattern for all known variations
const BRAND_PATTERN = /Dr\.?\s*Dave'?s?\s*Primal\s*Essence/gi;

/**
 * Rewrite the brand name in a product title for display.
 *
 * Prefers shopifyTitle when available (already uses "Tallowbourn").
 * Falls back to amazonTitle with brand replacement.
 *
 * Returns "Untitled" if both inputs are empty/null.
 */
export function displayTitle(
  amazonTitle?: string | null,
  shopifyTitle?: string | null,
): string {
  // Prefer Shopify title (already branded correctly)
  if (shopifyTitle && shopifyTitle.trim()) {
    return shopifyTitle.trim();
  }

  // Rewrite Amazon title
  if (amazonTitle && amazonTitle.trim()) {
    return amazonTitle.trim().replace(BRAND_PATTERN, BRAND_NEW);
  }

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
