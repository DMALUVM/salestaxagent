/**
 * Daily inventory action queue for solo-operator workflow.
 * Mirrors core flag/reorder logic from /inventory without seasonal walk-forward.
 */

import {
  coverTargetDays,
  DEFAULT_INVENTORY_SETTINGS,
  effectiveLeadDays,
  inventoryOnHand,
  reorderQty,
} from "./inventory-reorder";
import type {
  InventoryLeadtimeSummary,
  InventoryRestock,
  InventorySettings,
  InventorySkuSignals,
  InventorySnapshot,
  SkuVelocity,
} from "./types";

export type InventoryAction = {
  sku: string;
  productName: string;
  severity: "critical" | "restock" | "investigate" | "ship";
  label: string;
  detail: string;
  href: string;
  reorderQty: number;
  dos: number;
  stockoutDate: string | null;
  sortKey: number;
};

type RawLike = {
  snapshots?: InventorySnapshot[];
  velocity?: SkuVelocity[];
  restock?: InventoryRestock[];
  tpl?: Array<{ sku: string; available: number; product_name?: string | null }>;
  awd?: Array<{ sku: string; awd_on_hand: number }>;
  settings?: InventorySettings | null;
  signals?: InventorySkuSignals[];
  leadtime?: InventoryLeadtimeSummary | null;
};

export function buildInventoryActions(raw: RawLike | null, limit = 8): InventoryAction[] {
  if (!raw) return [];

  const settings = raw.settings ?? DEFAULT_INVENTORY_SETTINGS;

  const snapMap = new Map((raw.snapshots ?? []).map((s) => [s.sku, s]));
  const velMap = new Map((raw.velocity ?? []).map((v) => [v.sku, v]));
  const sigMap = new Map((raw.signals ?? []).map((s) => [s.sku, s]));
  const tplMap = new Map((raw.tpl ?? []).map((t) => [t.sku, t]));
  const awdMap = new Map((raw.awd ?? []).map((a) => [a.sku, a]));

  const allSkus = new Set([
    ...(raw.snapshots ?? []).map((s) => s.sku),
    ...(raw.velocity ?? []).map((v) => v.sku),
  ]);

  const target = coverTargetDays(settings);
  const actions: InventoryAction[] = [];
  const eps = 0.001;

  for (const sku of allSkus) {
    if (sku === "UNKNOW" || sku === "UNKNOWN") continue;

    const snap = snapMap.get(sku);
    const vel = velMap.get(sku);
    const sig = sigMap.get(sku);
    const tpl = tplMap.get(sku);
    const awdItem = awdMap.get(sku);

    const fulfillable = Number(snap?.fulfillable ?? 0);
    const fbaOnHand =
      fulfillable +
      Number(snap?.reserved ?? 0) +
      Number(snap?.researching ?? 0) +
      Number(snap?.unfulfillable ?? 0);
    const inbound =
      Number(snap?.inbound_working ?? 0) +
      Number(snap?.inbound_shipped ?? 0) +
      Number(snap?.inbound_receiving ?? 0);
    const awdOnHand = Number(awdItem?.awd_on_hand ?? 0);
    const tplAvail = Number(tpl?.available ?? 0);

    const totalVel = Number(vel?.total_u_30 ?? 0);
    const amazonVel = Number(vel?.amazon_u_30 ?? 0);
    const shopifyVel = Number(vel?.shopify_u_30 ?? 0);

    const amazonActive =
      fbaOnHand > 0 || awdOnHand > 0 || inbound > 0 || amazonVel > eps;
    const shopifyOnly = !amazonActive && (shopifyVel > eps || tplAvail > 0);
    if (!amazonActive && !shopifyOnly && totalVel <= eps) continue;

    const onHand = inventoryOnHand({
      fba: fbaOnHand,
      inbound,
      awd: awdOnHand,
      tpl: tplAvail,
      includeInbound: settings.include_inbound,
      include3pl: settings.include_3pl,
      includeAwd: settings.include_awd,
    });

    const lead = shopifyOnly
      ? settings.lead_time_days
      : effectiveLeadDays({
          sig,
          leadtime: raw.leadtime,
          receivingDaysNormal: settings.receiving_days_normal,
          awdToFbaDays: settings.awd_to_fba_days,
          awdOnHand,
          fbaOnHand,
          inbound,
        });

    const demand = shopifyOnly ? shopifyVel : totalVel;
    const supply = shopifyOnly ? tplAvail : onHand;
    const dos = demand > eps ? fbaOnHand / demand : fbaOnHand > 0 ? 9999 : 0;
    const qty = reorderQty(target, lead, demand, supply);

    const productName =
      vel?.product_name ?? snap?.product_name ?? tpl?.product_name ?? sku;

    if (sig?.rate_agreement === "investigate") {
      actions.push({
        sku,
        productName,
        severity: "investigate",
        label: `${sku} — rate divergence`,
        detail: `Inv V30 vs orders ${sig.rate_divergence_pct ?? "?"}% — verify before reorder`,
        href: `/inventory?sku=${encodeURIComponent(sku)}`,
        reorderQty: qty,
        dos,
        stockoutDate: null,
        sortKey: 150,
      });
    }

    if (!shopifyOnly && dos < 60 && demand > eps) {
      actions.push({
        sku,
        productName,
        severity: "critical",
        label: `${sku} — CRITICAL`,
        detail: `${Math.round(dos)}d FBA cover · reorder ${qty.toLocaleString()} u`,
        href: `/inventory/plan?sku=${encodeURIComponent(sku)}`,
        reorderQty: qty,
        dos,
        stockoutDate: null,
        sortKey: 10 + dos,
      });
    } else if (qty > 0) {
      actions.push({
        sku,
        productName,
        severity: "restock",
        label: `${sku} — reorder`,
        detail: `${qty.toLocaleString()} u · ${Math.round(dos)}d cover · ${lead}d lead`,
        href: `/inventory/plan?sku=${encodeURIComponent(sku)}`,
        reorderQty: qty,
        dos,
        stockoutDate: null,
        sortKey: 100 + dos,
      });
    }
  }

  const severityOrder = { critical: 0, ship: 1, restock: 2, investigate: 3 };
  return actions
    .sort(
      (a, b) =>
        severityOrder[a.severity] - severityOrder[b.severity] ||
        a.sortKey - b.sortKey,
    )
    .slice(0, limit);
}

export function inventoryActionSummary(raw: RawLike | null): {
  critical: number;
  restock: number;
  investigate: number;
  totalReorder: number;
} {
  const actions = buildInventoryActions(raw, 500);
  return {
    critical: actions.filter((a) => a.severity === "critical").length,
    restock: actions.filter((a) => a.severity === "restock").length,
    investigate: actions.filter((a) => a.severity === "investigate").length,
    totalReorder: actions.reduce((s, a) => s + a.reorderQty, 0),
  };
}
