/** First-box vs last-box receive on multi-FC AWD→FBA splits. */

export const SPLIT_MIN_FCS = 2;
export const SPLIT_MIN_DAYS = 1;
export const SPLIT_MAX_DAYS = 45;

export type SplitLeadtime = {
  first_box_days: number | null;
  last_box_days: number | null;
  box_spread_days: number | null;
  split_n: number;
  open_split?: {
    shipped_on: string;
    boxes: number;
    fcs: string[];
    age_days: number | null;
  } | null;
};

function parseMs(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function daySpan(start?: string | null, end?: string | null): number | null {
  const a = parseMs(start);
  const b = parseMs(end);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

function medianInt(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor((s.length - 1) / 2);
  if (s.length % 2 === 1) return s[mid];
  return Math.round((s[mid] + s[mid + 1]) / 2);
}

type Outbound = {
  shipmentStatus?: string;
  createdAt?: string;
  updatedAt?: string;
};

function outboundList(order: {
  raw?: { outboundShipments?: Outbound[] } | null;
}): Outbound[] {
  const raw = order.raw;
  if (!raw || !Array.isArray(raw.outboundShipments)) return [];
  return raw.outboundShipments.filter((ob) => ob && typeof ob === "object");
}

export function splitLegDays(order: {
  shipped_at?: string | null;
  created_at?: string | null;
  raw?: { outboundShipments?: Outbound[] } | null;
}): number[] {
  const outbound = outboundList(order);
  let start = order.shipped_at || order.created_at || null;
  const days: number[] = [];
  for (const ob of outbound) {
    if (String(ob.shipmentStatus ?? "").toUpperCase() !== "DELIVERED") continue;
    if (!start) start = ob.createdAt ?? null;
    const span = daySpan(start, ob.updatedAt);
    if (span != null && span >= SPLIT_MIN_DAYS && span <= SPLIT_MAX_DAYS) {
      days.push(span);
    }
  }
  return days;
}

export function firstLastFromReplenishments(
  orders: Array<{
    order_status?: string | null;
    shipped_at?: string | null;
    created_at?: string | null;
    raw?: { outboundShipments?: Outbound[] } | null;
  }>,
): SplitLeadtime {
  const firsts: number[] = [];
  const lasts: number[] = [];
  const spreads: number[] = [];
  for (const order of orders) {
    if (String(order.order_status ?? "").toUpperCase() !== "SUCCESS") continue;
    const days = splitLegDays(order);
    if (days.length < SPLIT_MIN_FCS) continue;
    firsts.push(Math.min(...days));
    lasts.push(Math.max(...days));
    spreads.push(Math.max(...days) - Math.min(...days));
  }
  return {
    first_box_days: medianInt(firsts),
    last_box_days: medianInt(lasts),
    box_spread_days: medianInt(spreads),
    split_n: firsts.length,
  };
}

export function openInboundSplit(
  ships: Array<{
    shipment_status?: string | null;
    shipped_at?: string | null;
    created_at?: string | null;
    destination_fc?: string | null;
  }>,
  today = new Date(),
): SplitLeadtime["open_split"] {
  const byDay = new Map<string, typeof ships>();
  for (const s of ships) {
    const status = String(s.shipment_status ?? "").toUpperCase();
    if (status === "CLOSED" || status === "CANCELLED" || status === "DELETED") continue;
    const day = String(s.shipped_at || s.created_at || "").slice(0, 10);
    if (!day) continue;
    const cur = byDay.get(day) ?? [];
    cur.push(s);
    byDay.set(day, cur);
  }
  const days = [...byDay.keys()].sort().reverse();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  for (const day of days) {
    const group = byDay.get(day) ?? [];
    const fcs = [...new Set(group.map((s) => s.destination_fc).filter((fc): fc is string => !!fc))].sort();
    if (fcs.length < SPLIT_MIN_FCS) continue;
    const age = Number.isNaN(Date.parse(`${day}T00:00:00Z`))
      ? null
      : Math.round((Date.parse(`${todayYmd}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    return {
      shipped_on: day,
      boxes: group.length,
      fcs,
      age_days: age,
    };
  }
  return null;
}
