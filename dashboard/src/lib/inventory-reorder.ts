/**
 * Shared inventory reorder math — inventory page and pallet planner
 * must use the same formula:
 *
 *   reorder = max(ceil((cover + lead) × V30) − on_hand, 0)
 */
import type {
  InventoryLeadtimeSummary,
  InventorySettings,
  InventorySkuSignals,
} from "./types";

export const HOLIDAY_COVER_DAYS = 90;

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  target_cover_days: 60,
  lead_time_days: 35,
  holiday_mode: false,
  include_inbound: true,
  include_3pl: true,
  include_awd: true,
  receiving_days_normal: 14,
  receiving_days_peak: 28,
  awd_to_fba_days: 14,
  production_lead_days: 45,
  peak_start_date: null,
  peak_end_date: null,
};

export function coverTargetDays(
  settings: Pick<InventorySettings, "holiday_mode" | "target_cover_days">,
): number {
  return settings.holiday_mode ? HOLIDAY_COVER_DAYS : settings.target_cover_days;
}

export function inventoryOnHand(args: {
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  includeInbound?: boolean;
  include3pl?: boolean;
  includeAwd?: boolean;
}): number {
  let n = args.fba;
  if (args.includeInbound !== false) n += args.inbound;
  if (args.include3pl !== false) n += args.tpl;
  if (args.includeAwd !== false) n += args.awd;
  return n;
}

export function effectiveLeadDays(args: {
  sig?: InventorySkuSignals | undefined;
  leadtime?: InventoryLeadtimeSummary | null;
  receivingDaysNormal: number;
  awdToFbaDays: number;
  awdOnHand: number;
  fbaOnHand: number;
  inbound: number;
}): number {
  const fba =
    (args.sig?.measured_receive_days && args.sig.measured_receive_days > 0
      ? args.sig.measured_receive_days
      : null) ??
    args.leadtime?.fba_optimized_receive_median ??
    args.leadtime?.fba_receive_median ??
    args.receivingDaysNormal;
  const awd =
    (args.sig?.measured_replenish_days && args.sig.measured_replenish_days > 0
      ? args.sig.measured_replenish_days
      : null) ??
    args.leadtime?.awd_replenish_median ??
    args.awdToFbaDays;
  if (args.awdOnHand > 0 && args.awdOnHand >= args.fbaOnHand + args.inbound) {
    return Math.max(fba, awd);
  }
  return fba;
}

export function reorderQty(
  targetDays: number,
  leadDays: number,
  dailyVelocity: number,
  onHand: number,
): number {
  if (dailyVelocity <= 0) return 0;
  return Math.max(Math.ceil((targetDays + leadDays) * dailyVelocity) - onHand, 0);
}

export function amazonInventoryReorder(args: {
  settings: InventorySettings;
  sig?: InventorySkuSignals;
  leadtime?: InventoryLeadtimeSummary | null;
  fba: number;
  inbound: number;
  awd: number;
  tpl: number;
  dailyVelocity: number;
}): { targetDays: number; leadDays: number; onHand: number; reorderQty: number } {
  const targetDays = coverTargetDays(args.settings);
  const onHand = inventoryOnHand({
    fba: args.fba,
    inbound: args.inbound,
    awd: args.awd,
    tpl: args.tpl,
    includeInbound: args.settings.include_inbound,
    include3pl: args.settings.include_3pl,
    includeAwd: args.settings.include_awd,
  });
  const leadDays = effectiveLeadDays({
    sig: args.sig,
    leadtime: args.leadtime,
    receivingDaysNormal: args.settings.receiving_days_normal,
    awdToFbaDays: args.settings.awd_to_fba_days,
    awdOnHand: args.awd,
    fbaOnHand: args.fba,
    inbound: args.inbound,
  });
  return {
    targetDays,
    leadDays,
    onHand,
    reorderQty: reorderQty(targetDays, leadDays, args.dailyVelocity, onHand),
  };
}
