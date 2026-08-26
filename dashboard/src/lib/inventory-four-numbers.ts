/**
 * Four-number supply plan (dashboard mirror of supply_plan.py).
 */

import {
  buildInboundWavePlan,
  holidayDemandUnits,
  type SkuVelocityRow,
  type InventorySnapshot,
} from "./inventory-inbound-waves";
import {
  phasedAvgDaily,
  phasedStockoutDate,
  type ForecastWeekRow,
  type SeasonalityWeek,
} from "./inventory-phased-demand";
import { computeManufactureTiming, nextWarehouseShip } from "./inventory-supply-display";

export const PRODUCTION_LEAD_DAYS = {
  lip: 42,
  balm: 70,
  deodorant: 70,
  other: 70,
} as const;

export type ProductLine = keyof typeof PRODUCTION_LEAD_DAYS;

const LIP_BALM_SKUS = new Set([
  "DDPE0001Shop",
  "DDPE0002Shop",
  "DDPE0003Shop",
  "DDPE0004Shop",
]);

export function skuProductLine(sku: string, productName = ""): ProductLine {
  const text = `${sku} ${productName}`.toLowerCase();
  if (
    LIP_BALM_SKUS.has(sku) ||
    text.startsWith("ddpe") ||
    (text.includes("lip") && text.includes("balm"))
  ) {
    return "lip";
  }
  if (/\b(deodorant|deo)\b/.test(text)) return "deodorant";
  if (text.includes("balm") || text.includes("tallow")) return "balm";
  return "other";
}

export function productionLeadDays(line: ProductLine): number {
  return PRODUCTION_LEAD_DAYS[line] ?? PRODUCTION_LEAD_DAYS.other;
}

export type WarehouseShipment = {
  destination: "FBA" | "AWD";
  units: number;
  ship_by: string;
  arrive_date: string;
  urgent: boolean;
  note?: string;
};

export type SkuFourNumbers = {
  sku: string;
  productName: string;
  productLine: ProductLine;
  productionLeadDays: number;
  manufactureQty: number;
  orderBy: string | null;
  orderUrgent: boolean;
  nextShipBy: string | null;
  shipUrgent: boolean;
  shipToFba: number;
  shipToFbaTotal: number;
  shipToAwd: number;
  warehouseShipments: WarehouseShipment[];
  fbaDosPhased: number | null;
  fbaStockoutDate: string | null;
  networkOosDate: string | null;
  networkSupply: number;
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  holidayDemand: number;
  warehouseShort: number;
};

export type FourNumbersPlan = {
  generated: string;
  untilDate: string;
  receivingDays: number;
  coverTargetDays: number;
  skuRows: SkuFourNumbers[];
  wavesConsolidated: Array<{
    ship_by: string;
    mix: Record<string, number>;
    total_units: number;
    urgent: boolean;
  }>;
  totalManufacture: number;
  totalWarehouseShipFba: number;
  totalWarehouseShipAwd: number;
};

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildFourNumbersPlan(opts: {
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
  awdToFbaDays?: number;
}): FourNumbersPlan {
  const inbound = buildInboundWavePlan({
    skus: opts.skus,
    snapshots: opts.snapshots,
    velocities: opts.velocities,
    tpl: opts.tpl,
    awd: opts.awd,
    seasonality: opts.seasonality,
    forecast: opts.forecast,
    untilDate: opts.untilDate,
    bufferDays: opts.bufferDays,
    coverTargetDays: opts.coverTargetDays,
    receivingDays: opts.receivingDays,
    awdToFbaDays: opts.awdToFbaDays,
  });

  const snapMap = new Map(opts.snapshots.map((s) => [s.sku, s]));
  const velMap = new Map(opts.velocities.map((v) => [v.sku, v]));
  const tplMap = new Map(opts.tpl.map((t) => [t.sku, t]));
  const awdMap = new Map(opts.awd.map((a) => [a.sku, a]));
  const inboundBySku = new Map(inbound.skuPlans.map((p) => [p.sku, p]));

  const accountSeasonality = opts.seasonality.filter(
    (s) => !(s as { sku?: string }).sku || (s as { sku?: string }).sku === "_account_",
  );
  if (accountSeasonality.length === 0) {
    accountSeasonality.push(...opts.seasonality);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const recvDays = inbound.receivingDays;

  const skuRows: SkuFourNumbers[] = [];
  let totalManufacture = 0;
  let totalFba = 0;
  let totalAwd = 0;

  for (const sku of opts.skus) {
    const snap = snapMap.get(sku);
    const vel = velMap.get(sku);
    const productName = vel?.product_name ?? sku;
    const line = skuProductLine(sku, productName);
    const prodLead = productionLeadDays(line);

    const fba =
      Number(snap?.fulfillable ?? 0) +
      Number(snap?.reserved ?? 0) +
      Number(snap?.researching ?? 0) +
      Number(snap?.unfulfillable ?? 0);
    const inboundQty =
      Number(snap?.inbound_working ?? 0) +
      Number(snap?.inbound_shipped ?? 0) +
      Number(snap?.inbound_receiving ?? 0);
    const awdOh = Number(awdMap.get(sku)?.awd_on_hand ?? 0);
    const tplOh = Number(tplMap.get(sku)?.available ?? 0);
    const baseDaily = Number(vel?.total_u_30 ?? 0);

    const inboundPlan = inboundBySku.get(sku);
    const waves = inboundPlan?.waves ?? [];
    const tplWaves = waves.filter((w) => w.source === "3PL");
    const awdWaves = waves.filter((w) => w.source === "AWD");

    const shipFba = tplWaves.reduce((s, w) => s + w.units, 0);
    const shipTplToAwd =
      awdOh === 0 && tplOh > shipFba ? tplOh - shipFba : 0;

    const manufactureQty = inboundPlan?.produceShort ?? 0;

    const timing = computeManufactureTiming({
      manufactureQty,
      tplShipWaves: tplWaves.map((w) => ({
        ship_by: w.ship_by,
        urgent: w.urgent,
      })),
      productionLeadDays: prodLead,
      receivingDays: recvDays,
      today,
    });

    const nextShip = nextWarehouseShip(tplWaves, today);

    let fbaDosPhased: number | null = null;
    let fbaStockoutDate: string | null = null;
    let networkOosDate: string | null = null;

    if (baseDaily > 0) {
      const phasedDaily = phasedAvgDaily(
        baseDaily,
        sku,
        60,
        accountSeasonality,
        opts.forecast,
      );
      fbaDosPhased = phasedDaily > 0 ? Math.round(fba / phasedDaily) : null;

      // FBA only — existing inbound still in pipeline counts as supply
      fbaStockoutDate = phasedStockoutDate(
        fba + inboundQty,
        baseDaily,
        sku,
        accountSeasonality,
        opts.forecast,
      );

      const network = fba + inboundQty + awdOh + tplOh;
      networkOosDate = phasedStockoutDate(
        network,
        baseDaily,
        sku,
        accountSeasonality,
        opts.forecast,
      );
    }

    const warehouseShipments: WarehouseShipment[] = [];
    for (const w of tplWaves) {
      warehouseShipments.push({
        destination: "FBA",
        units: w.units,
        ship_by: w.ship_by,
        arrive_date: w.arrive_date,
        urgent: w.urgent,
      });
    }
    for (const w of awdWaves) {
      warehouseShipments.push({
        destination: "FBA",
        units: w.units,
        ship_by: w.ship_by,
        arrive_date: w.arrive_date,
        urgent: w.urgent,
        note: "AWD → FBA transfer",
      });
    }
    if (shipTplToAwd > 0) {
      const shipBy = new Date(today);
      shipBy.setDate(shipBy.getDate() + 7);
      const arrive = new Date(today);
      arrive.setDate(arrive.getDate() + recvDays);
      warehouseShipments.push({
        destination: "AWD",
        units: shipTplToAwd,
        ship_by: localDate(shipBy),
        arrive_date: localDate(arrive),
        urgent: false,
        note: "3PL overflow staging",
      });
    }

    skuRows.push({
      sku,
      productName,
      productLine: line,
      productionLeadDays: prodLead,
      manufactureQty,
      orderBy: timing.orderBy,
      orderUrgent: timing.orderUrgent,
      nextShipBy: nextShip.shipBy ?? timing.nextShipBy,
      shipUrgent: nextShip.urgent || timing.shipUrgent,
      shipToFba: nextShip.units,
      shipToFbaTotal: shipFba,
      shipToAwd: shipTplToAwd,
      warehouseShipments,
      fbaDosPhased,
      fbaStockoutDate,
      networkOosDate,
      networkSupply: fba + inboundQty + awdOh + tplOh,
      fba,
      inbound: inboundQty,
      awd: awdOh,
      tpl: tplOh,
      holidayDemand: inboundPlan?.holidayDemand ?? holidayDemandUnits(vel),
      warehouseShort: inboundPlan?.warehouseShort ?? 0,
    });

    totalManufacture += manufactureQty;
    totalFba += nextShip.units;
    totalAwd += shipTplToAwd;
  }

  return {
    generated: inbound.generated,
    untilDate: inbound.untilDate,
    receivingDays: inbound.receivingDays,
    coverTargetDays: inbound.coverTargetDays,
    skuRows,
    wavesConsolidated: inbound.wavesConsolidated,
    totalManufacture,
    totalWarehouseShipFba: totalFba,
    totalWarehouseShipAwd: totalAwd,
  };
}
