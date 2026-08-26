/**
 * Warehouse → Amazon inbound wave planner (dashboard mirror of inbound_waves.py).
 * Schedules 3PL shipments with receiving lead time so FBA keeps ≥60d cover at phased demand.
 */

import {
  phasedDemandUnits,
  type ForecastWeekRow,
  type SeasonalityWeek,
} from "./inventory-phased-demand";
import {
  holidayDemandCoveringProjections,
  holidayDemandWithPlanning,
  planningDaily,
} from "./pallet-plan";

export const DEFAULT_RECEIVING_DAYS = 18;
export const DEFAULT_COVER_DAYS = 60;
export const FORWARD_COVER_WEEKS = 9;

export type InventorySnapshot = {
  sku: string;
  fulfillable?: number;
  reserved?: number;
  researching?: number;
  unfulfillable?: number;
  inbound_working?: number;
  inbound_shipped?: number;
  inbound_receiving?: number;
};

export type SkuVelocityRow = {
  sku: string;
  product_name?: string;
  total_u_30?: number;
  total_u_90?: number;
  planning_u_30?: number;
  holiday_prior_daily?: number;
  summer_prior_daily?: number;
  yoy_growth_mult?: number;
  holiday_surge_mult?: number;
};

export type InboundWave = {
  sku: string;
  source: "3PL" | "AWD";
  units: number;
  arrive_date: string;
  ship_by: string;
  urgent: boolean;
};

export type SkuInboundPlan = {
  sku: string;
  productName: string;
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  ownedTotal: number;
  holidayDemand: number;
  holidayFbaGap: number;
  warehouseShort: number;
  produceShort: number;
  totalShipFromWarehouse: number;
  waves: InboundWave[];
  alerts: Array<{
    sku: string;
    week: string;
    cover_days?: number;
    message?: string;
  }>;
};

export type ConsolidatedWave = {
  ship_by: string;
  mix: Record<string, number>;
  total_units: number;
  urgent: boolean;
};

export type InboundPlanResult = {
  generated: string;
  untilDate: string;
  coverTargetDays: number;
  receivingDays: number;
  skuPlans: SkuInboundPlan[];
  wavesConsolidated: ConsolidatedWave[];
  totalWarehouseShip: number;
  totalWarehouseShort: number;
  totalProduceShort: number;
  totalHolidayDemand: number;
};

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

function weeklyDemand(
  baseDaily: number,
  cursor: Date,
  weekEnd: Date,
  seasonMap: Map<number, number>,
  forecastWeeks: { start: number; units: number }[],
): number {
  const days =
    Math.floor((weekEnd.getTime() - cursor.getTime()) / 86400000) + 1;
  const mult = seasonMap.get(isoWeekClamped(cursor)) ?? 1.0;
  const fc = forecastUnitsForRange(
    forecastWeeks,
    cursor.getTime(),
    weekEnd.getTime(),
  );
  if (fc != null) return Math.round(fc * (days / 7));
  return Math.round(baseDaily * days * mult);
}

/** Phased average daily demand over the next `horizonDays` from `start` (matches PhDOS). */
function forwardPhasedAvgDaily(
  start: Date,
  end: Date,
  baseDaily: number,
  horizonDays: number,
  seasonMap: Map<number, number>,
  forecastWeeks: { start: number; units: number }[],
): number {
  let totalUnits = 0;
  let countedDays = 0;
  const cursor = new Date(start);
  while (countedDays < horizonDays && cursor <= end) {
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());
    const spanDays =
      Math.floor((weekEnd.getTime() - cursor.getTime()) / 86400000) + 1;
    const useDays = Math.min(spanDays, horizonDays - countedDays);
    const weekUnits = weeklyDemand(
      baseDaily,
      cursor,
      weekEnd,
      seasonMap,
      forecastWeeks,
    );
    totalUnits += weekUnits * (useDays / spanDays);
    countedDays += useDays;
    cursor.setDate(cursor.getDate() + spanDays);
  }
  return countedDays > 0 ? totalUnits / countedDays : baseDaily;
}

/** Inbound / AWD receipts already scheduled to arrive within receiving lead time. */
function pipelineReceiptsAhead(
  scheduled: Map<number, number>,
  wi: number,
  weeks: Date[],
  leadDays: number,
): number {
  let total = 0;
  const deadlineMs = weeks[wi].getTime() + leadDays * 86400000;
  for (let fj = wi + 1; fj < weeks.length; fj++) {
    if (weeks[fj].getTime() > deadlineMs) break;
    total += scheduled.get(fj) ?? 0;
  }
  return total;
}

function weekList(start: Date, end: Date): Date[] {
  const monday = new Date(start);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks: Date[] = [];
  const cursor = new Date(monday);
  while (cursor <= end) {
    weeks.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

/** Holiday demand Nov–Dec + Jan — same covering math as the pallet planner. */
export function holidayDemandUnits(
  vel: SkuVelocityRow | undefined,
  forecasts?: ForecastWeekRow[],
  sku?: string,
): number {
  const daily = planningDaily(vel ?? {});
  if (forecasts && sku) {
    return holidayDemandCoveringProjections(forecasts, sku, daily).plannedTotal;
  }
  return holidayDemandWithPlanning(0, daily, true);
}

export function buildInboundWavePlan(opts: {
  skus: string[];
  snapshots: InventorySnapshot[];
  velocities: SkuVelocityRow[];
  tpl: Array<{ sku: string; available: number }>;
  awd: Array<{ sku: string; awd_on_hand: number }>;
  seasonality: SeasonalityWeek[];
  forecast: ForecastWeekRow[];
  untilDate?: string;
  bufferDays?: number;
  coverTargetDays?: number;
  receivingDays?: number;
  includeAwdInSupply?: boolean;
  inboundArriveWeek?: number;
  awdToFbaDays?: number;
}): InboundPlanResult {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endParts = (opts.untilDate ?? "2027-01-15").split("-").map(Number);
  const end = new Date(endParts[0], endParts[1] - 1, endParts[2]);
  end.setDate(end.getDate() + (opts.bufferDays ?? 14));

  const coverTarget = opts.coverTargetDays ?? DEFAULT_COVER_DAYS;
  const recvDays = opts.receivingDays ?? DEFAULT_RECEIVING_DAYS;
  const awdDays = opts.awdToFbaDays ?? 14;
  const includeAwd = opts.includeAwdInSupply ?? true;
  // In-transit inbound typically lands within one receiving cycle
  const inboundWeek =
    opts.inboundArriveWeek ??
    Math.max(0, Math.min(Math.ceil(recvDays / 7) - 1, 1));
  const awdWeek = Math.max(1, Math.ceil(awdDays / 7));

  const seasonMap = new Map<number, number>();
  for (const s of opts.seasonality) {
    if ((s as { sku?: string }).sku === "_account_" || !(s as { sku?: string }).sku) {
      seasonMap.set(Number(s.week), Number(s.multiplier));
    }
  }
  if (seasonMap.size === 0) {
    for (const s of opts.seasonality) {
      seasonMap.set(Number(s.week), Number(s.multiplier));
    }
  }

  const snapMap = new Map(opts.snapshots.map((s) => [s.sku, s]));
  const velMap = new Map(opts.velocities.map((v) => [v.sku, v]));
  const tplMap = new Map(opts.tpl.map((t) => [t.sku, t]));
  const awdMap = new Map(opts.awd.map((a) => [a.sku, a]));

  const weeks = weekList(today, end);
  const skuPlans: SkuInboundPlan[] = [];
  const allWaves: InboundWave[] = [];

  for (const sku of opts.skus) {
    const snap = snapMap.get(sku);
    const vel = velMap.get(sku);
    const baseDaily = Number(vel?.total_u_30 ?? 0);

    const fba =
      Number(snap?.fulfillable ?? 0) +
      Number(snap?.reserved ?? 0) +
      Number(snap?.researching ?? 0) +
      Number(snap?.unfulfillable ?? 0);
    const inbound =
      Number(snap?.inbound_working ?? 0) +
      Number(snap?.inbound_shipped ?? 0) +
      Number(snap?.inbound_receiving ?? 0);
    const awdOh = Number(awdMap.get(sku)?.awd_on_hand ?? 0);
    const tplOh = Number(tplMap.get(sku)?.available ?? 0);
    const ownedTotal = fba + inbound + awdOh + tplOh;
    const fbaSupply = fba + inbound + (includeAwd ? awdOh : 0);

    const holidayDemand = holidayDemandUnits(vel, opts.forecast, sku);
    const holidayFbaGap = Math.max(holidayDemand - fbaSupply, 0);
    const warehouseShortStatic = Math.max(holidayFbaGap - tplOh, 0);
    // 3PL is a transfer, not a manufacture offset — same as pallet planner.
    const produceShort = holidayFbaGap;

    if (baseDaily <= 0) {
      skuPlans.push({
        sku,
        productName: vel?.product_name ?? sku,
        fba,
        inbound,
        awd: awdOh,
        tpl: tplOh,
        ownedTotal,
        holidayDemand,
        holidayFbaGap,
        warehouseShort: warehouseShortStatic,
        produceShort,
        totalShipFromWarehouse: 0,
        waves: [],
        alerts: [],
      });
      continue;
    }

    const forecastWeeks = buildForecastIndex(opts.forecast, sku);
    const demandByWeek = new Map<string, number>();
    for (const w of weeks) {
      const weekEnd = new Date(w);
      weekEnd.setDate(weekEnd.getDate() + 6);
      if (weekEnd > end) weekEnd.setTime(end.getTime());
      demandByWeek.set(
        localDate(w),
        weeklyDemand(baseDaily, w, weekEnd, seasonMap, forecastWeeks),
      );
    }

    const scheduled = new Map<number, number>();
    if (inbound > 0) {
      scheduled.set(Math.min(inboundWeek, weeks.length - 1), inbound);
    }
    let awdPool = includeAwd ? 0 : awdOh;
    if (includeAwd && awdOh > 0) {
      const idx = Math.min(awdWeek, weeks.length - 1);
      scheduled.set(idx, (scheduled.get(idx) ?? 0) + awdOh);
    }

    let warehousePool = tplOh;
    const waves: InboundWave[] = [];
    const alerts: SkuInboundPlan["alerts"] = [];
    let fbaSim = fba;

    for (let wi = 0; wi < weeks.length; wi++) {
      const w = weeks[wi];
      const wIso = localDate(w);
      const receipt = scheduled.get(wi) ?? 0;
      fbaSim += receipt;

      // Phased demand over cover horizon (not 9-week blend that pulls Nov peak into August)
      const avgDaily = forwardPhasedAvgDaily(
        w,
        end,
        baseDaily,
        coverTarget,
        seasonMap,
        forecastWeeks,
      );
      const pipeline = pipelineReceiptsAhead(scheduled, wi, weeks, recvDays);
      const effectiveFba = fbaSim + pipeline;
      const coverDays = avgDaily > 0 ? effectiveFba / avgDaily : 999;
      const replenishThreshold = coverTarget - 7;
      const inboundGrace =
        inbound > 0
          ? Math.max(replenishThreshold - 8, recvDays + 7)
          : replenishThreshold;
      const flagged = coverDays < inboundGrace && coverDays < 999;

      if (flagged && avgDaily > 0) {
        const targetFba = coverTarget * avgDaily;
        let deficit = Math.ceil(Math.max(targetFba - effectiveFba, 0));
        const criticalUrgent = coverDays < recvDays;

        // Incremental waves in trough — only dump warehouse when lead time forces it
        const waveCap = criticalUrgent
          ? warehousePool
          : Math.min(
              warehousePool,
              Math.max(Math.ceil(avgDaily * recvDays), Math.ceil(avgDaily * 7)),
            );

        const fromAwd = Math.min(deficit, awdPool, waveCap);
        if (fromAwd > 0) {
          awdPool -= fromAwd;
          scheduled.set(wi, (scheduled.get(wi) ?? 0) + fromAwd);
          fbaSim += fromAwd;
          const shipBy = new Date(w);
          shipBy.setDate(shipBy.getDate() - awdDays);
          const urgent = criticalUrgent;
          waves.push({
            sku,
            source: "AWD",
            units: fromAwd,
            arrive_date: wIso,
            ship_by: localDate(shipBy),
            urgent,
          });
          deficit -= fromAwd;
        }

        const tplCap = criticalUrgent
          ? warehousePool
          : Math.min(warehousePool, waveCap - fromAwd);
        const fromTpl = Math.min(deficit, tplCap);
        if (fromTpl > 0) {
          warehousePool -= fromTpl;
          scheduled.set(wi, (scheduled.get(wi) ?? 0) + fromTpl);
          fbaSim += fromTpl;
          const shipBy = new Date(w);
          shipBy.setDate(shipBy.getDate() - recvDays);
          const urgent = criticalUrgent;
          waves.push({
            sku,
            source: "3PL",
            units: fromTpl,
            arrive_date: wIso,
            ship_by: localDate(shipBy),
            urgent,
          });
          if (urgent) {
            alerts.push({
              sku,
              week: wIso,
              cover_days: Math.round(coverDays),
              message: "Ship immediately — cover below receiving lead time",
            });
          }
        }
      }

      const wkDemand = demandByWeek.get(wIso) ?? 0;
      fbaSim = Math.max(fbaSim - wkDemand, 0);

      if (flagged) {
        alerts.push({ sku, week: wIso, cover_days: Math.round(coverDays) });
      }
    }

    const tplShipTotal = waves
      .filter((w) => w.source === "3PL")
      .reduce((s, w) => s + w.units, 0);
    const warehouseShortLive = Math.max(tplShipTotal - tplOh, 0);

    skuPlans.push({
      sku,
      productName: vel?.product_name ?? sku,
      fba,
      inbound,
      awd: awdOh,
      tpl: tplOh,
      ownedTotal,
      holidayDemand,
      holidayFbaGap,
      warehouseShort: Math.max(warehouseShortStatic, warehouseShortLive),
      produceShort,
      totalShipFromWarehouse: tplShipTotal,
      waves,
      alerts,
    });
    allWaves.push(...waves);
  }

  const byShip = new Map<string, Record<string, number>>();
  for (const w of allWaves) {
    if (w.source !== "3PL") continue;
    const mix = byShip.get(w.ship_by) ?? {};
    mix[w.sku] = (mix[w.sku] ?? 0) + w.units;
    byShip.set(w.ship_by, mix);
  }

  const wavesConsolidated: ConsolidatedWave[] = Array.from(byShip.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ship_by, mix]) => ({
      ship_by,
      mix,
      total_units: Object.values(mix).reduce((s, n) => s + n, 0),
      urgent: allWaves.some(
        (w) => w.source === "3PL" && w.ship_by === ship_by && w.urgent,
      ),
    }));

  return {
    generated: localDate(today),
    untilDate: localDate(end),
    coverTargetDays: coverTarget,
    receivingDays: recvDays,
    skuPlans,
    wavesConsolidated,
    totalWarehouseShip: skuPlans.reduce((s, p) => s + p.totalShipFromWarehouse, 0),
    totalWarehouseShort: skuPlans.reduce((s, p) => s + p.warehouseShort, 0),
    totalProduceShort: skuPlans.reduce((s, p) => s + p.produceShort, 0),
    totalHolidayDemand: skuPlans.reduce((s, p) => s + p.holidayDemand, 0),
  };
}
