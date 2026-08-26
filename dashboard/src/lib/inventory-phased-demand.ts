/**
 * Phased demand for inventory DOS / stockout / reorder.
 * Matches inventory/plan: V30 × weekly seasonality (and imported forecast when present).
 * Never applies peak holiday velocity in the slow season (Aug/Sep).
 */

export type SeasonalityWeek = { week: number; multiplier: number };

export type ForecastWeekRow = {
  sku: string;
  week_start: string;
  scenario: string;
  units: number;
};

function isoWeekClamped(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const isoWeek = Math.ceil(
    ((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7,
  );
  return Math.max(1, Math.min(52, isoWeek || 1));
}

function buildForecastIndex(rows: ForecastWeekRow[], sku: string) {
  const weeks: { start: number; units: number }[] = [];
  for (const f of rows) {
    if (f.sku !== sku || f.scenario !== "correction_factor") continue;
    weeks.push({
      start: new Date(f.week_start + "T00:00:00").getTime(),
      units: Number(f.units),
    });
  }
  weeks.sort((a, b) => a.start - b.start);
  return weeks;
}

function forecastUnitsForRange(
  forecastWeeks: { start: number; units: number }[],
  cursorMs: number,
  endMs: number,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const fw of forecastWeeks) {
    const fwEnd = fw.start + 6 * 86400000;
    if (fw.start <= endMs && fwEnd >= cursorMs) {
      const dist = Math.abs(fw.start - cursorMs);
      if (dist < bestDist) {
        best = fw.units;
        bestDist = dist;
      }
    }
  }
  return best;
}

/** Sum demand over horizon days from today (plan-page style). */
export function phasedDemandUnits(
  baseDailyV30: number,
  sku: string,
  horizonDays: number,
  seasonality: SeasonalityWeek[],
  forecastRows: ForecastWeekRow[],
): number {
  if (baseDailyV30 <= 0 || horizonDays <= 0) return 0;

  const seasonMap = new Map<number, number>();
  for (const s of seasonality) {
    if ((s as { sku?: string }).sku === "_account_" || !(s as { sku?: string }).sku) {
      seasonMap.set(Number(s.week), Number(s.multiplier));
    }
  }
  // Account-level only for phased walk (matches plan page)
  if (seasonMap.size === 0) {
    for (const s of seasonality) {
      seasonMap.set(Number(s.week), Number(s.multiplier));
    }
  }

  const forecastWeeks = buildForecastIndex(forecastRows, sku);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + horizonDays);

  let cursor = new Date(today);
  let total = 0;

  while (cursor < end) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());

    const days =
      Math.floor((weekEnd.getTime() - cursor.getTime()) / 86400000) + 1;
    const clampedWk = isoWeekClamped(cursor);
    const mult = seasonMap.get(clampedWk) ?? 1.0;

    const forecastUnits = forecastUnitsForRange(
      forecastWeeks,
      cursor.getTime(),
      weekEnd.getTime(),
    );
    const demand =
      forecastUnits != null
        ? Math.round(forecastUnits * (days / 7))
        : Math.round(baseDailyV30 * days * mult);

    total += demand;
    cursor = new Date(weekEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return total;
}

/** FBA stockout date walking V30 × seasonality (ramps in Nov–Jan, not peak rate today). */
export function phasedStockoutDate(
  stock: number,
  baseDailyV30: number,
  sku: string,
  seasonality: SeasonalityWeek[],
  forecastRows: ForecastWeekRow[],
): string | null {
  if (stock <= 0) return new Date().toISOString().slice(0, 10);
  if (baseDailyV30 <= 0.001) return null;

  const seasonMap = new Map<number, number>();
  for (const s of seasonality) {
    seasonMap.set(Number(s.week), Number(s.multiplier));
  }

  const forecastWeeks = buildForecastIndex(forecastRows, sku);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let remaining = stock;
  let cursor = new Date(today);

  for (let i = 0; i < 104; i++) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const days = 7;
    const clampedWk = isoWeekClamped(cursor);
    const mult = seasonMap.get(clampedWk) ?? 1.0;

    const forecastUnits = forecastUnitsForRange(
      forecastWeeks,
      cursor.getTime(),
      weekEnd.getTime(),
    );
    const weekDemand =
      forecastUnits != null
        ? forecastUnits
        : Math.round(baseDailyV30 * days * mult);

    if (weekDemand <= 0) {
      cursor.setDate(cursor.getDate() + 7);
      continue;
    }

    if (remaining <= weekDemand) {
      const frac = remaining / weekDemand;
      const out = new Date(cursor);
      out.setDate(out.getDate() + Math.floor(frac * 7));
      return out.toISOString().slice(0, 10);
    }
    remaining -= weekDemand;
    cursor.setDate(cursor.getDate() + 7);
  }
  return null;
}

/** Average daily demand over next N days (for forward cover display). */
export function phasedAvgDaily(
  baseDailyV30: number,
  sku: string,
  days: number,
  seasonality: SeasonalityWeek[],
  forecastRows: ForecastWeekRow[],
): number {
  const units = phasedDemandUnits(
    baseDailyV30,
    sku,
    days,
    seasonality,
    forecastRows,
  );
  return days > 0 ? units / days : baseDailyV30;
}
