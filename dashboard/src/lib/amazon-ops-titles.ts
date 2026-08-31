/**
 * Product Performance titles for /amazon.
 *
 * Parent ASINs in amazon_asin_traffic do not exist in sku_velocity (child-only).
 * A 6-char prefix match paints the first child variant onto the parent
 * (B0CLHTF8YN → Sweet Orange). Overrides in config/asin_titles.json are the
 * first source. The JSON is imported so it ships with the Vercel dashboard
 * regardless of process.cwd().
 */
import bundledTitles from "../../config/asin_titles.json";

export type AsinTrafficRow = {
  parent_asin?: string | null;
  product_name?: string | null;
  [key: string]: unknown;
};

export type TitleSourceRow = {
  asin?: string | null;
  product_name?: string | null;
};

/** Skip `_comment` and any non-string / empty values. */
export function parseAsinTitleOverrides(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "_comment" || key.startsWith("_")) continue;
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Parent titles bundled with the dashboard. Static import so cwd=`dashboard/`
 * (Vercel) still resolves — no process.cwd() file read.
 */
export function loadShippedAsinTitleOverrides(): Record<string, string> {
  return parseAsinTitleOverrides(bundledTitles as Record<string, unknown>);
}

/** Exact parent-ASIN match only. Never prefix-match a child variant. */
export function resolveParentProductNames<T extends AsinTrafficRow>(
  rows: T[],
  overrides: Record<string, string>,
  dbTitles: Iterable<TitleSourceRow>,
): T[] {
  const titleMap = new Map<string, string>();
  for (const src of dbTitles) {
    const asin = (src.asin ?? "").trim();
    const name = (src.product_name ?? "").trim();
    if (asin && name && !titleMap.has(asin)) titleMap.set(asin, name);
  }

  for (const row of rows) {
    const parentAsin = String(row.parent_asin ?? "").trim();
    if (!parentAsin) continue;

    const override = overrides[parentAsin];
    if (override) {
      row.product_name = override;
      continue;
    }

    const existing = typeof row.product_name === "string" ? row.product_name.trim() : "";
    if (existing && existing !== parentAsin) continue;

    const exact = titleMap.get(parentAsin);
    if (exact) row.product_name = exact;
  }
  return rows;
}
