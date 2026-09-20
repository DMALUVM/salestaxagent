/**
 * Shopper-funnel math — dashboard twin of src/shopify_funnel.py.
 *
 * Closed funnel (ShopifyQL `sessions`, human only):
 *   sessions → add_to_cart → checkout_started → purchases
 *
 * PDP (`pdp_sessions`) is sessions that *landed* on a product page. It is
 * not a closed-funnel gate. A missing count stays null — never coerced to 0.
 */

export const WINDOW_DAYS = [7, 28] as const;
export type FunnelWindow = (typeof WINDOW_DAYS)[number];

export type FunnelCounts = {
  sessions: number | null;
  pdpSessions: number | null;
  addToCart: number | null;
  checkoutStarted: number | null;
  purchases: number | null;
};

export type FunnelStep = {
  key: string;
  label: string;
  count: number | null;
  note?: string | null;
};

export type DropOff = {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  lost: number | null;
  rate: number | null;
  conversion: number | null;
  nested: boolean | null;
  present: boolean;
};

export type Leak = {
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  lost: number;
  rate: number | null;
};

export type AbandonedRow = {
  checkout_id: string;
  checkout_name: string | null;
  checkout_date: string;
  created_at: string;
  completed_at: string | null;
  total_price: number | null;
  currency: string | null;
  recovered: boolean;
  line_items: Array<{
    title?: string | null;
    quantity?: number;
    handle?: string | null;
    sku?: string | null;
    amount?: number | null;
  }>;
  line_items_qty: number | null;
  triage_severity: "hold_for_review" | "needs_eyes" | "noise" | null;
  triage_note: string | null;
  shipping_address_started?: boolean | null;
  billing_address_started?: boolean | null;
  has_discount?: boolean | null;
  discount_codes?: string[] | null;
  discount_amount?: number | null;
  has_shipping_rate?: boolean | null;
  payment_attempted?: boolean | null;
  recovery_status?: "open" | "recovered" | null;
};

const CLOSED: Array<[keyof FunnelCounts | string, string]> = [
  ["sessions", "Sessions"],
  ["addToCart", "Added to cart"],
  ["checkoutStarted", "Reached checkout"],
  ["purchases", "Purchased"],
];

export function asInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function asMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function dropOff(prev: number | null, curr: number | null): Omit<DropOff, "from" | "fromLabel" | "to" | "toLabel"> {
  if (prev === null || curr === null) {
    return { lost: null, rate: null, conversion: null, nested: null, present: false };
  }
  const nested = curr <= prev;
  if (prev <= 0) {
    return { lost: nested ? 0 : null, rate: null, conversion: null, nested, present: true };
  }
  if (!nested) {
    return {
      lost: null, rate: null,
      conversion: Math.round((curr / prev) * 10000) / 10000,
      nested: false, present: true,
    };
  }
  const lost = prev - curr;
  return {
    lost,
    rate: Math.round((lost / prev) * 10000) / 10000,
    conversion: Math.round((curr / prev) * 10000) / 10000,
    nested: true,
    present: true,
  };
}

export function conversionRate(start: number | null, end: number | null): number | null {
  if (start === null || end === null || start <= 0) return null;
  return Math.round((end / start) * 10000) / 10000;
}

export function emptyCounts(): FunnelCounts {
  return {
    sessions: null, pdpSessions: null, addToCart: null,
    checkoutStarted: null, purchases: null,
  };
}

export function sumDaily(
  rows: Array<Record<string, unknown>>,
  start: string,
  end: string,
): FunnelCounts {
  const acc: FunnelCounts = emptyCounts();
  const map: Array<[string, keyof FunnelCounts]> = [
    ["sessions", "sessions"],
    ["pdp_sessions", "pdpSessions"],
    ["add_to_cart", "addToCart"],
    ["checkout_started", "checkoutStarted"],
    ["purchases", "purchases"],
  ];
  for (const r of rows) {
    if (String(r.split_kind ?? "all") !== "all") continue;
    const d = String(r.metric_date ?? "");
    if (d < start || d > end) continue;
    for (const [col, key] of map) {
      const v = asInt(r[col]);
      if (v === null) continue;
      acc[key] = (acc[key] ?? 0) + v;
    }
  }
  return acc;
}

export function stepsOf(c: FunnelCounts, includePdp = true): FunnelStep[] {
  const out: FunnelStep[] = [{ key: "sessions", label: "Sessions", count: c.sessions }];
  if (includePdp && c.pdpSessions !== null) {
    out.push({
      key: "pdp_sessions", label: "Landed on PDP", count: c.pdpSessions,
      note: "Landing page was a product page. Not a closed-funnel gate.",
    });
  }
  out.push({ key: "add_to_cart", label: "Added to cart", count: c.addToCart });
  out.push({ key: "checkout_started", label: "Reached checkout", count: c.checkoutStarted });
  out.push({ key: "purchases", label: "Purchased", count: c.purchases });
  return out;
}

export function dropOffPath(steps: FunnelStep[]): DropOff[] {
  const out: DropOff[] = [];
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1];
    const b = steps[i];
    out.push({
      from: a.key, fromLabel: a.label, to: b.key, toLabel: b.label,
      ...dropOff(a.count, b.count),
    });
  }
  return out;
}

export function closedDropOff(c: FunnelCounts): DropOff[] {
  const steps: FunnelStep[] = CLOSED.map(([key, label]) => ({
    key: String(key),
    label,
    count: c[key as keyof FunnelCounts],
  }));
  return dropOffPath(steps);
}

export function biggestLeak(c: FunnelCounts): Leak | null {
  const leaks = closedDropOff(c).filter((d) => d.nested && d.lost !== null) as Array<DropOff & { lost: number }>;
  if (!leaks.length) return null;
  leaks.sort((a, b) => (b.lost - a.lost) || ((b.rate ?? 0) - (a.rate ?? 0)));
  const top = leaks[0];
  return {
    from: top.from, fromLabel: top.fromLabel,
    to: top.to, toLabel: top.toLabel,
    lost: top.lost, rate: top.rate,
  };
}

export function windowBounds(end: string, days: FunnelWindow): { start: string; end: string } {
  const [y, m, d] = end.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - (days - 1));
  const start = dt.toISOString().slice(0, 10);
  return { start, end };
}

export function recoveryOf(rows: AbandonedRow[]) {
  const n = rows.length;
  const recovered = rows.filter((r) => r.recovered).length;
  const openRows = rows.filter((r) => !r.recovered);
  let value = 0;
  let known = 0;
  for (const r of openRows) {
    const amt = asMoney(r.total_price);
    if (amt === null) continue;
    value += amt;
    known += 1;
  }
  return {
    count: n,
    recovered,
    open: n - recovered,
    recoveryRate: n ? Math.round((recovered / n) * 10000) / 10000 : null,
    openValue: Math.round(value * 100) / 100,
    openValueKnown: known,
    openValueMissing: (n - recovered) - known,
  };
}

export function topAbandonedProducts(rows: AbandonedRow[], limit = 10) {
  const buckets = new Map<string, {
    key: string; title: string; handle: string | null;
    quantity: number; amount: number; checkouts: number;
  }>();
  for (const r of rows) {
    if (r.recovered) continue;
    for (const it of r.line_items ?? []) {
      const title = String(it.title ?? "").trim();
      if (!title) continue;
      const key = it.handle || title;
      const b = buckets.get(key) ?? {
        key, title, handle: it.handle ?? null,
        quantity: 0, amount: 0, checkouts: 0,
      };
      b.quantity += Number(it.quantity ?? 0);
      const amt = asMoney(it.amount);
      if (amt !== null) b.amount += amt;
      b.checkouts += 1;
      buckets.set(key, b);
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, amount: Math.round(b.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount || b.quantity - a.quantity || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function filterAbandoned(rows: AbandonedRow[], start: string, end: string) {
  return rows.filter((r) => r.checkout_date >= start && r.checkout_date <= end);
}

const KIT_TOKENS = ["kit", "pack", "bundle", "set"] as const;
const STICK_TOKENS = ["stick", "single", "chapstick"] as const;

export function kitKind(handle?: string | null, title?: string | null, sku?: string | null): "kit" | "stick" | "other" {
  const blob = [handle, title, sku].filter(Boolean).join(" ").toLowerCase().replace(/-/g, " ");
  if (KIT_TOKENS.some((t) => blob.includes(t))) return "kit";
  if (STICK_TOKENS.some((t) => blob.includes(t))) return "stick";
  return "other";
}

export function productLeakFromAbandons(rows: AbandonedRow[], limit = 15) {
  const byHandle = new Map<string, {
    handle: string | null; title: string; kind: ReturnType<typeof kitKind>;
    open: number; recovered: number; quantity: number; openValue: number;
  }>();
  const byKind = {
    kit: { kind: "kit", open: 0, recovered: 0, openValue: 0, quantity: 0 },
    stick: { kind: "stick", open: 0, recovered: 0, openValue: 0, quantity: 0 },
    other: { kind: "other", open: 0, recovered: 0, openValue: 0, quantity: 0 },
  };
  for (const r of rows) {
    const recovered = Boolean(r.recovered);
    for (const it of r.line_items ?? []) {
      const title = String(it.title ?? "").trim();
      const handle = (it.handle ?? "").trim() || null;
      if (!title && !handle) continue;
      const key = handle || title;
      const kind = kitKind(handle, title, it.sku);
      const qty = Number(it.quantity ?? 0);
      const amt = asMoney(it.amount);
      const b = byHandle.get(key) ?? {
        handle, title, kind, open: 0, recovered: 0, quantity: 0, openValue: 0,
      };
      b.quantity += qty;
      if (recovered) b.recovered += 1;
      else {
        b.open += 1;
        if (amt !== null) b.openValue += amt;
      }
      byHandle.set(key, b);
      const k = byKind[kind];
      k.quantity += qty;
      if (recovered) k.recovered += 1;
      else {
        k.open += 1;
        if (amt !== null) k.openValue += amt;
      }
    }
  }
  const products = [...byHandle.values()]
    .map((b) => {
      const total = b.open + b.recovered;
      return {
        ...b,
        openValue: Math.round(b.openValue * 100) / 100,
        recoveryRate: total ? Math.round((b.recovered / total) * 10000) / 10000 : null,
      };
    })
    .sort((a, b) => b.openValue - a.openValue || b.open - a.open || a.title.localeCompare(b.title))
    .slice(0, limit);
  const kinds = (["kit", "stick", "other"] as const).map((kind) => {
    const row = byKind[kind];
    const total = row.open + row.recovered;
    return {
      ...row,
      openValue: Math.round(row.openValue * 100) / 100,
      recoveryRate: total ? Math.round((row.recovered / total) * 10000) / 10000 : null,
    };
  });
  return {
    source: "abandoned_line_items",
    note: "Abandon mix by product/handle — not ShopifyQL ATC→checkout.",
    kinds,
    products,
  };
}

export function frictionRollup(rows: AbandonedRow[]) {
  const openRows = rows.filter((r) => !r.recovered);
  const count = (field: keyof AbandonedRow, want: boolean) =>
    openRows.filter((r) => r[field] === want).length;
  const unknown = (field: keyof AbandonedRow) =>
    openRows.filter((r) => r[field] == null).length;
  return {
    open: openRows.length,
    shippingAddressStarted: count("shipping_address_started", true),
    shippingAddressMissing: count("shipping_address_started", false),
    billingAddressStarted: count("billing_address_started", true),
    hasDiscount: count("has_discount", true),
    shippingRateUnknown: unknown("has_shipping_rate"),
    paymentAttemptUnknown: unknown("payment_attempted"),
  };
}

export function deviceWindow(
  rows: Array<Record<string, unknown>>,
  start: string,
  end: string,
) {
  const buckets = new Map<string, FunnelCounts>();
  const map: Array<[string, keyof FunnelCounts]> = [
    ["sessions", "sessions"],
    ["pdp_sessions", "pdpSessions"],
    ["add_to_cart", "addToCart"],
    ["checkout_started", "checkoutStarted"],
    ["purchases", "purchases"],
  ];
  for (const r of rows) {
    if (String(r.split_kind ?? "") !== "device") continue;
    const d = String(r.metric_date ?? "");
    if (d < start || d > end) continue;
    const key = String(r.split_value || "unknown");
    const b = buckets.get(key) ?? emptyCounts();
    for (const [col, field] of map) {
      const v = asInt(r[col]);
      if (v === null) continue;
      b[field] = (b[field] ?? 0) + v;
    }
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .map(([device, c]) => ({ device, ...c, leak: biggestLeak(c) }))
    .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0) || a.device.localeCompare(b.device));
}

export function channelWindow(
  rows: Array<Record<string, unknown>>,
  start: string,
  end: string,
) {
  const buckets = new Map<string, FunnelCounts>();
  const map: Array<[string, keyof FunnelCounts]> = [
    ["sessions", "sessions"],
    ["pdp_sessions", "pdpSessions"],
    ["add_to_cart", "addToCart"],
    ["checkout_started", "checkoutStarted"],
    ["purchases", "purchases"],
  ];
  for (const r of rows) {
    if (String(r.split_kind ?? "") !== "channel") continue;
    const d = String(r.metric_date ?? "");
    if (d < start || d > end) continue;
    const key = String(r.split_value || "unknown");
    const b = buckets.get(key) ?? emptyCounts();
    for (const [col, field] of map) {
      const v = asInt(r[col]);
      if (v === null) continue;
      b[field] = (b[field] ?? 0) + v;
    }
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .map(([channel, c]) => ({ channel, ...c, leak: biggestLeak(c) }))
    .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0) || a.channel.localeCompare(b.channel));
}

export function pct(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

export function money(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  })}`;
}

/** Kit Email refresh contract. This app never HTTP those IDs. */
export const KLAVIYO_KIT_REFRESH = {
  method: "get_flow_report",
  flow_ids: ["WcDdsx", "SQa2Yy"],
  conversion_metric_id: "UG4R5c",
  aggregation: "flow_aggregation",
  wrote_klaviyo: false,
} as const;

export type KlaviyoAbandonRow = {
  as_of?: string | null;
  window_days: number;
  flow_id?: string | null;
  flow_name?: string | null;
  revenue?: number | null;
  unique_clicks?: number | null;
  conversion_metric_id?: string | null;
  notes?: string | null;
};

export type KlaviyoWindowSummary = {
  window_days: number;
  revenue: number | null;
  unique_clicks_zero: boolean;
};

export function summarizeKlaviyo(rows: KlaviyoAbandonRow[]) {
  const byWindow = new Map<number, KlaviyoWindowSummary>();
  for (const r of rows) {
    const w = Number(r.window_days);
    if (!Number.isFinite(w)) continue;
    const b = byWindow.get(w) ?? {
      window_days: w, revenue: null, unique_clicks_zero: false,
    };
    const amt = asMoney(r.revenue);
    if (amt !== null) b.revenue = Math.round(((b.revenue ?? 0) + amt) * 100) / 100;
    if (r.unique_clicks === 0) b.unique_clicks_zero = true;
    byWindow.set(w, b);
  }
  return {
    as_of: rows[0]?.as_of ?? null,
    conversion_metric_id: rows[0]?.conversion_metric_id ?? "UG4R5c",
    windows: [...byWindow.values()].sort((a, b) => b.window_days - a.window_days),
    refresh: KLAVIYO_KIT_REFRESH,
  };
}

export const DEFINITIONS: Array<[string, string]> = [
  ["Source", "Shopify Admin GraphQL only. Funnel counts come from ShopifyQL FROM sessions (human sessions). Abandoned checkouts come from abandonedCheckouts. Not GA4, not Clarity, not a CSV export."],
  ["Closed funnel", "sessions → sessions_with_cart_additions → sessions_that_reached_checkout → sessions_that_completed_checkout. Each step is a subset of the previous."],
  ["Landed on PDP", "Sessions whose landing_page_type is product. Shoppers can add to cart from a collection, so this is not a closed-funnel gate. Mid-session PDP views are not a ShopifyQL metric we store."],
  ["Drop-off", "(previous − next) ÷ previous when both counts are present and next ≤ previous. A missing ShopifyQL column stays blank — never a fabricated 100% leak. If next > previous the step is labelled not nested."],
  ["Biggest leak", "The closed-funnel step that lost the most sessions by count, not by rate."],
  ["Abandoned $", "Sum of total_price on checkouts that have not been completed. Recovered = completedAt is set. A missing amount is counted in the list but not invented into the $ total."],
  ["Recovery rate", "Completed (recovered) checkouts ÷ checkouts in the window. Cheap: it is a stored timestamp, not an email-send campaign metric."],
  ["Triage", "Stub severity until Jev is wired. Fail closed → hold for review. The sync does not call an LLM."],
  ["Windows", "Last 7 or 28 store days (America/New_York), inclusive of the latest stored date."],
  ["Friction", "shippingAddress / billingAddress presence, discountCodes, totalDiscountSet, completedAt. GraphQL AbandonedCheckout has no shippingLine or payment-attempt field — those stay unknown. Address values are not stored."],
  ["Kit vs stick", "Token classify on abandoned line-item title/handle (kit/pack/bundle/set vs stick/single). Not a session ATC→checkout. ShopifyQL sessions has no product-handle closed funnel."],
  ["Channel", "ShopifyQL GROUP BY referring_channel when read_reports is granted. Device uses session_device_type."],
  ["Klaviyo", "Read-only stub seeded from Kit Email (flows WcDdsx / SQa2Yy, metric UG4R5c). This app does not write to Klaviyo. Kit refresh: get_flow_report contains-any those flow ids."],
];
