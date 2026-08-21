import { normalizeChannel, SHOPIFY, AMAZON } from "./channels";

/**
 * Overview "Last 30 Days" series builder.
 *
 * Extracted from app/page.tsx UNCHANGED in behaviour so it can be tested: the
 * window, the local-date normalisation and the channel bucketing are exactly
 * what the page did before. See overview-series.test.ts — that test is the
 * regression guard for the shape of this series.
 *
 * The window is the 30 days ENDING YESTERDAY in the viewer's local timezone.
 * Today is excluded on purpose: it is still accruing and would always render as
 * a short bar.
 *
 * The one behavioural addition is `hasData`, which distinguishes "we have a row
 * for this day and it was $0" from "no row exists". The chart needs that to
 * draw a gap rather than a stub bar that reads as a real, terrible day.
 */

export interface SalesDailyRow {
  /** False when the writing job did not cover the whole day. */
  is_complete?: boolean | null;
  sale_date: string;
  channel: string;
  gross_sales: number | string | null;
}

export interface SeriesPoint {
  date: string;
  shopify: number;
  amazon: number;
  /** Total for the day — the tooltip and the bar height both read this. */
  total: number;
  /** False when no sales_daily row exists for this date at all. */
  hasData: boolean;
  /**
   * False while the day is still in progress, so the chart can mark it rather
   * than presenting a part-day as a final figure. Today is always incomplete;
   * closed days are complete unless a writer flagged otherwise.
   */
  isComplete: boolean;
}

/** YYYY-MM-DD in the viewer's local timezone (never UTC — see page.tsx). */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const SERIES_DAYS = 30;

/**
 * Build the 30-day stacked series ending yesterday.
 *
 * @param rows sales_daily rows (any channels; only Shopify and Amazon are kept)
 * @param now  reference "now"; the series ends the day before this
 */
export function buildLast30Series(
  rows: SalesDailyRow[],
  now: Date = new Date(),
  days: number = SERIES_DAYS,
): SeriesPoint[] {
  const dailyMap = new Map<string,
    { shopify: number; amazon: number; isComplete: boolean }>();
  for (const row of rows ?? []) {
    if (!row?.sale_date) continue;
    const ch = normalizeChannel(row.channel);
    let entry = dailyMap.get(row.sale_date);
    if (!entry) {
      entry = { shopify: 0, amazon: 0, isComplete: true };
      dailyMap.set(row.sale_date, entry);
    }
    // A day is only complete if EVERY channel's row for it is complete: a
    // finished Amazon pull does not make the day final if Shopify was partial.
    if (row.is_complete === false) entry.isComplete = false;
    if (ch === SHOPIFY) entry.shopify += Number(row.gross_sales ?? 0);
    else if (ch === AMAZON) entry.amazon += Number(row.gross_sales ?? 0);
  }

  const out: SeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Local-midnight arithmetic, so a DST shift cannot drop or duplicate a day.
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1 - i);
    const ds = localDate(d);
    const entry = dailyMap.get(ds);
    const shopify = entry?.shopify ?? 0;
    const amazon = entry?.amazon ?? 0;
    out.push({
      date: ds,
      shopify,
      amazon,
      total: shopify + amazon,
      hasData: entry !== undefined,
      // Written by the sync: false when that run did not cover the whole day.
      // A day with no row at all is not "incomplete", it is absent — that is
      // what hasData already says.
      isComplete: entry?.isComplete ?? true,
    });
  }
  return out;
}
