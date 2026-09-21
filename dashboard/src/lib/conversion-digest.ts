/**
 * Conversion Digest — stable read-only JSON for Iris (Dana owns numbers).
 *
 * Date-lock: as_of is a closed America/New_York day. Default is yesterday ET.
 * Never substitute an older complete day when the requested day is missing.
 *
 * Funnel / primary_leak / abandons: shopify_funnel_* only.
 * improvements: ranked as_of actions from that day's Shopify leak plus
 * locked-day GA4 / GSC / Ads when material. Each string names the metric,
 * the change, and an owner tag ([Harry]/[Nora]/[Blake]/[Blair]/[Kit]).
 * Empty when nothing material. Jev hold does not blank evidence.
 * Never invents metrics. No Meta copy. No theme / Shopify writes.
 */

import { agentAsOf, agentToday } from "./as-of";
import {
  DIGEST_ABANDON_KIT_MIN,
  jevItemsFromLockedDay,
  rankDigestItems,
  type JevItem,
} from "./funnel-jev-triage";
import {
  adsWaste,
  gscOpportunities,
  type Phase2Digest,
} from "./phase2-digest";
import {
  asInt,
  biggestLeak,
  conversionRate,
  recoveryOf,
  topAbandonedProducts,
  type AbandonedRow,
  type FunnelCounts,
} from "./shopify-funnel";

export const DIGEST_SOURCE = "shopify_funnel_*" as const;
export const DEFINITIONS_NOTE =
  "ShopifyQL human sessions + abandonedCheckouts only. Not GA4, not Meta, not orders-as-sessions.";

export type DigestStatus = "CLEAR" | "HOLD" | "GAP";

export type DigestImprovement = {
  rank: number;
  text: string;
  severity: string;
  step: string;
};

export type ConversionDigest = {
  as_of: string;
  status: DigestStatus;
  gap: string | null;
  funnel: {
    sessions: number | null;
    pdp_sessions: number | null;
    add_to_cart: number | null;
    checkout_started: number | null;
    purchases: number | null;
    rates: {
      session_to_atc: number | null;
      atc_to_checkout: number | null;
      checkout_to_purchase: number | null;
      session_to_purchase: number | null;
    };
  };
  primary_leak: {
    from: string;
    to: string;
    lost: number;
    rate: number | null;
  } | null;
  abandons: {
    open_count: number;
    open_value: number;
    currency: string | null;
    top_products: Array<{ title: string; qty: number; value: number }>;
  };
  improvements: DigestImprovement[];
  definitions_note: string;
  source: typeof DIGEST_SOURCE;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function defaultDigestAsOf(now: Date = new Date()): string {
  return agentAsOf(now);
}

export function parseDigestDate(
  raw: string | null | undefined,
  now: Date = new Date(),
): { asOf: string; error?: string } {
  if (raw == null || raw === "") return { asOf: defaultDigestAsOf(now) };
  const date = String(raw).trim();
  if (!YMD.test(date)) return { asOf: date, error: "date must be YYYY-MM-DD" };
  return { asOf: date };
}

export function isClosedEasternDay(asOf: string, now: Date = new Date()): boolean {
  return YMD.test(asOf) && asOf <= defaultDigestAsOf(now);
}

function emptyFunnel(): ConversionDigest["funnel"] {
  return {
    sessions: null,
    pdp_sessions: null,
    add_to_cart: null,
    checkout_started: null,
    purchases: null,
    rates: {
      session_to_atc: null,
      atc_to_checkout: null,
      checkout_to_purchase: null,
      session_to_purchase: null,
    },
  };
}

const LEAK_KEY: Record<string, string> = {
  sessions: "sessions",
  addToCart: "add_to_cart",
  checkoutStarted: "checkout_started",
  purchases: "purchases",
  pdpSessions: "pdp_sessions",
  add_to_cart: "add_to_cart",
  checkout_started: "checkout_started",
  pdp_sessions: "pdp_sessions",
};

function leakRef(from: string, to: string, lost: number, rate: number | null) {
  return {
    from: LEAK_KEY[from] ?? from,
    to: LEAK_KEY[to] ?? to,
    lost,
    rate,
  };
}

function emptyAbandons(): ConversionDigest["abandons"] {
  return { open_count: 0, open_value: 0, currency: null, top_products: [] };
}

export function countsFromDailyRow(
  row: Record<string, unknown> | null | undefined,
): FunnelCounts {
  if (!row) {
    return {
      sessions: null, pdpSessions: null, addToCart: null,
      checkoutStarted: null, purchases: null,
    };
  }
  return {
    sessions: asInt(row.sessions),
    pdpSessions: asInt(row.pdp_sessions),
    addToCart: asInt(row.add_to_cart),
    checkoutStarted: asInt(row.checkout_started),
    purchases: asInt(row.purchases),
  };
}

export function funnelFromCounts(c: FunnelCounts): ConversionDigest["funnel"] {
  return {
    sessions: c.sessions,
    pdp_sessions: c.pdpSessions,
    add_to_cart: c.addToCart,
    checkout_started: c.checkoutStarted,
    purchases: c.purchases,
    rates: {
      session_to_atc: conversionRate(c.sessions, c.addToCart),
      atc_to_checkout: conversionRate(c.addToCart, c.checkoutStarted),
      checkout_to_purchase: conversionRate(c.checkoutStarted, c.purchases),
      session_to_purchase: conversionRate(c.sessions, c.purchases),
    },
  };
}

export function improvementsFromJev(jev: unknown): DigestImprovement[] {
  if (!jev || typeof jev !== "object") return [];
  const j = jev as Record<string, unknown>;
  if (j.ran !== true || j.decision !== "pursue") return [];
  const rows = Array.isArray(j.pursue) ? j.pursue : [];
  const out: DigestImprovement[] = [];
  for (const raw of rows) {
    if (out.length >= 3) break;
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const answers = (row.jev && typeof row.jev === "object"
      ? row.jev : {}) as Record<string, unknown>;
    const sevChoice = (answers.severity && typeof answers.severity === "object"
      ? (answers.severity as { choice?: string }).choice : undefined)
      || (typeof row.severity === "string" ? row.severity : "");
    const stepChoice = (answers.step && typeof answers.step === "object"
      ? (answers.step as { choice?: string }).choice : undefined)
      || (typeof row.primary_step === "string" ? row.primary_step : "")
      || (typeof row.step === "string" ? row.step : "");
    const text = improvementText(row, sevChoice, stepChoice);
    if (!text) continue;
    out.push({
      rank: out.length + 1,
      text,
      severity: sevChoice || "p1",
      step: stepChoice || "unclear",
    });
  }
  return out;
}

function improvementText(
  row: Record<string, unknown>,
  sev: string,
  step: string,
): string | null {
  const leak = row.evidence && typeof row.evidence === "object"
    ? (row.evidence as { leak?: Record<string, unknown> }).leak
    : undefined;
  const lost = typeof row.current === "number" ? row.current
    : typeof leak?.lost === "number" ? leak.lost
    : null;
  const metric = typeof row.metric === "string" ? row.metric : "";
  if (!step && !metric && lost == null) return null;
  const bits: string[] = [];
  if (sev) bits.push(sev.toUpperCase());
  if (metric) bits.push(metric);
  else if (step) bits.push(step);
  if (lost != null) bits.push(`${lost} sessions lost`);
  return bits.join(" · ") || null;
}

function jevLabels(jev: unknown): { severity: string; step: string } | null {
  if (!jev || typeof jev !== "object") return null;
  const j = jev as Record<string, unknown>;
  if (j.ran !== true || j.decision !== "pursue") return null;
  const rows = Array.isArray(j.pursue) ? j.pursue : [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const answers = (row.jev && typeof row.jev === "object"
      ? row.jev : {}) as Record<string, unknown>;
    const sev = (answers.severity && typeof answers.severity === "object"
      ? (answers.severity as { choice?: string }).choice : undefined)
      || (typeof row.severity === "string" ? row.severity : "");
    const step = (answers.step && typeof answers.step === "object"
      ? (answers.step as { choice?: string }).choice : undefined)
      || (typeof row.primary_step === "string" ? row.primary_step : "")
      || (typeof row.step === "string" ? row.step : "");
    if (sev || step) return { severity: sev, step };
  }
  return null;
}

function fmtMoney(n: number): string {
  return n.toFixed(2);
}

function fmtConv(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function fmtPct(rate: number | null | undefined): string | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  const pct = Math.round(rate * 100);
  return `${pct}%`;
}

function fmtPos(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function titleCaseDevice(device: string): string {
  const d = device.trim().toLowerCase();
  if (d === "mobile") return "Mobile";
  if (d === "desktop") return "Desktop";
  if (d === "tablet") return "Tablet";
  return device.trim();
}

/** Collection/home/cart/chrome paths — Harry still owns copy; Blair owns theme. */
export function isThemeLayoutPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.toLowerCase().split("?")[0].replace(/\/+$/, "") || "/";
  if (/\/products?\//.test(p)) return false;
  if (p === "/" || p === "") return true;
  return /^\/(collections?|pages?|blogs?|cart|checkouts?|search|account|apps|challenge|policies|tools)(\/|$)/.test(p)
    || /theme|layout|template/.test(p);
}

export function ownerTagsForAction(item: JevItem): string[] {
  if (item.mode === "landing") {
    const tags = ["Harry"];
    if (isThemeLayoutPath(item.path)) tags.push("Blair");
    return tags;
  }
  if (item.mode === "seo") return ["Nora"];
  if (item.mode === "ads") return ["Blake"];
  if (item.mode === "leak") {
    const tags = ["Harry"];
    if ((item.abandon_value ?? 0) >= DIGEST_ABANDON_KIT_MIN) tags.push("Kit");
    return tags;
  }
  return [];
}

function ownerSuffix(item: JevItem): string {
  return ownerTagsForAction(item).map((t) => `[${t}]`).join(" ");
}

function leakAsk(step: string): string {
  if (step === "session_to_pdp") return "get landings onto a PDP";
  if (step === "pdp_to_atc") return "rewrite PDP benefit + ATC";
  if (step === "atc_to_checkout") return "cut cart-to-checkout friction";
  if (step === "checkout_to_purchase") return "cut checkout/payment friction";
  return "inspect the closed-funnel step";
}

function landingAsk(path: string): string {
  if (/\/products?\//i.test(path)) return "rewrite above-fold benefit + ATC friction";
  if (isThemeLayoutPath(path)) return "theme/layout or nav friction";
  return "landing-to-purchase drop";
}

function seoAsk(item: JevItem): string {
  if (item.clicks === 0) return "title+meta or content gap";
  if (item.position != null && Number.isFinite(item.position) && item.position >= 15) {
    return "title+meta or content gap";
  }
  return "title+meta or snippet";
}

export function improvementFromAction(item: JevItem): DigestImprovement | null {
  const sev = (item.severity || "p1").toLowerCase();
  const step = item.step || "unclear";
  const owners = ownerSuffix(item);
  if (!owners) return null;
  let text: string | null = null;
  if (item.mode === "leak") {
    const metric = (item.metric || step).replace(/->/g, "→");
    const lost = item.current;
    if (!metric || lost == null) return null;
    const bits = [`${lost} sessions lost`];
    const pct = fmtPct(item.delta_pct);
    if (pct) bits[0] += ` (${pct})`;
    if (item.abandon_value != null && item.abandon_value >= DIGEST_ABANDON_KIT_MIN) {
      bits.push(`$${fmtMoney(item.abandon_value)} open abandons`);
    }
    text = `Shopify ${metric}: ${bits.join(" · ")} — ${leakAsk(step)} ${owners}`;
  } else if (item.mode === "landing") {
    const path = (item.path || "").trim();
    if (!path || item.current == null) return null;
    const device = titleCaseDevice(item.device || "");
    const kind = /\/products?\//i.test(path) ? "PDP" : "";
    const head = [device, kind, path].filter(Boolean).join(" ");
    let metric: string;
    if (item.sessions != null && item.purchases != null) {
      metric = `${item.sessions} sessions → ${item.purchases} purchases`;
    } else {
      metric = `${item.current} lost sessions`;
      const pct = fmtPct(item.delta_pct);
      if (pct) metric += ` (${pct})`;
    }
    text = `${head}: ${metric} — ${landingAsk(path)} ${owners}`;
  } else if (item.mode === "seo") {
    const key = (item.query || "").trim();
    if (!key || item.impressions == null || item.clicks == null) return null;
    const kind = item.metric === "gsc_page" ? "page" : "query";
    const label = kind === "page" ? `GSC page ${key}` : `GSC query '${key}'`;
    const bits = [`${item.impressions} impr`, `${item.clicks} clicks`];
    if (item.position != null && Number.isFinite(item.position)) {
      bits.push(`pos ${fmtPos(item.position)}`);
    }
    text = `${label}: ${bits.join(" / ")} — ${seoAsk(item)} ${owners}`;
  } else if (item.mode === "ads") {
    const campaign = (item.campaign || "").trim();
    if (!campaign || item.spend == null || item.conversions == null) return null;
    const bits = [`$${fmtMoney(item.spend)}`];
    if (item.clicks != null) bits.push(`${item.clicks} clicks`);
    bits.push(`${fmtConv(item.conversions)} conv`);
    text = `Ads ${campaign}: ${bits.join(" / ")} — review negatives or pause ${owners}`;
  }
  if (!text) return null;
  return { rank: 0, text, severity: sev, step };
}

/** Locked-day ranked actions. Empty when no material as_of rows. */
export function improvementsFromLockedDay(input: {
  asOf: string;
  dailyRow: Record<string, unknown> | null | undefined;
  abandons?: AbandonedRow[];
  jev?: unknown;
  phase2?: Phase2Digest | null;
}): DigestImprovement[] {
  if (!input.dailyRow) return [];
  const counts = countsFromDailyRow(input.dailyRow);
  const rawLeak = biggestLeak(counts);
  const leak = rawLeak
    ? {
      from: LEAK_KEY[rawLeak.from] ?? rawLeak.from,
      to: LEAK_KEY[rawLeak.to] ?? rawLeak.to,
      lost: rawLeak.lost,
      rate: rawLeak.rate,
    }
    : null;
  const abandon = input.abandons?.length ? recoveryOf(input.abandons) : null;
  const p2 = input.phase2;
  const landings = (p2?.landing_drops ?? []).filter((d) => d.lost >= 10 && d.path);
  const seo = [
    ...gscOpportunities(p2?.seo?.queries ?? []).map((q) => ({ ...q, kind: "query" as const })),
    ...gscOpportunities(p2?.seo?.pages ?? []).map((q) => ({ ...q, kind: "page" as const })),
  ];
  const ads = adsWaste(p2?.ads ?? []);
  const items = jevItemsFromLockedDay({
    asOf: input.asOf,
    leak,
    abandon,
    landingDrops: landings,
    seoQueries: seo,
    ads,
  });
  const labels = jevLabels(input.jev);
  if (labels) {
    for (const item of items) {
      if (item.mode !== "leak") continue;
      if (labels.severity) item.severity = labels.severity;
      if (labels.step) item.step = labels.step;
    }
  }
  const ranked = rankDigestItems(items);
  const out: DigestImprovement[] = [];
  for (const item of ranked) {
    const row = improvementFromAction(item);
    if (!row) continue;
    row.rank = out.length + 1;
    out.push(row);
  }
  return out;
}

export function buildConversionDigest(input: {
  asOf: string;
  now?: Date;
  dailyRow: Record<string, unknown> | null;
  funnelOk: boolean | null;
  abandons: AbandonedRow[];
  jev: unknown;
  phase2?: Phase2Digest | null;
}): ConversionDigest {
  const now = input.now ?? new Date();
  const base = {
    as_of: input.asOf,
    funnel: emptyFunnel(),
    primary_leak: null as ConversionDigest["primary_leak"],
    abandons: emptyAbandons(),
    improvements: [] as DigestImprovement[],
    definitions_note: DEFINITIONS_NOTE,
    source: DIGEST_SOURCE,
  };

  if (!YMD.test(input.asOf)) {
    return {
      ...base,
      status: "GAP",
      gap: "date must be YYYY-MM-DD. Not substituting another day.",
    };
  }
  if (input.asOf > agentToday(now)) {
    return {
      ...base,
      status: "GAP",
      gap: `${input.asOf} is not a closed America/New_York day. Not substituting an older day.`,
    };
  }
  if (input.asOf === agentToday(now)) {
    return {
      ...base,
      status: "GAP",
      gap: `${input.asOf} is today ET (partial). Digest is prior-day only. Not substituting an older day.`,
    };
  }
  if (!isClosedEasternDay(input.asOf, now)) {
    return {
      ...base,
      status: "GAP",
      gap: `${input.asOf} is not a closed America/New_York day. Not substituting an older day.`,
    };
  }

  if (!input.dailyRow) {
    return {
      ...base,
      status: "GAP",
      gap: `No shopify_funnel_daily row for ${input.asOf} (America/New_York). Not substituting an older day.`,
    };
  }
  if (input.funnelOk !== true) {
    const counts = countsFromDailyRow(input.dailyRow);
    const leak = biggestLeak(counts);
    return {
      ...base,
      status: "HOLD",
      gap: `shopify_funnel_status.funnel_ok is not true for ${input.asOf}. ShopifyQL unavailable or denied.`,
      funnel: funnelFromCounts(counts),
      primary_leak: leak
        ? leakRef(leak.from, leak.to, leak.lost, leak.rate)
        : null,
      abandons: abandonsOf(input.abandons),
      improvements: improvementsFromLockedDay({
        asOf: input.asOf,
        dailyRow: input.dailyRow,
        abandons: input.abandons,
        jev: input.jev,
        phase2: input.phase2,
      }),
    };
  }

  const counts = countsFromDailyRow(input.dailyRow);
  const leak = biggestLeak(counts);
  return {
    ...base,
    status: "CLEAR",
    gap: null,
    funnel: funnelFromCounts(counts),
    primary_leak: leak
      ? leakRef(leak.from, leak.to, leak.lost, leak.rate)
      : null,
    abandons: abandonsOf(input.abandons),
    improvements: improvementsFromLockedDay({
      asOf: input.asOf,
      dailyRow: input.dailyRow,
      abandons: input.abandons,
      jev: input.jev,
      phase2: input.phase2,
    }),
  };
}

function abandonsOf(rows: AbandonedRow[]): ConversionDigest["abandons"] {
  const rec = recoveryOf(rows);
  const currency = rows.find((r) => r.currency)?.currency ?? null;
  const top = topAbandonedProducts(rows, 3).map((p) => ({
    title: p.title,
    qty: p.quantity,
    value: p.amount,
  }));
  return {
    open_count: rec.open,
    open_value: rec.openValue,
    currency,
    top_products: top,
  };
}

/** Exported so tests can pin the date-lock: requested ≠ latest available. */
export function mustNotSubstitute(requested: string, latestAvailable: string | null): boolean {
  return latestAvailable != null && latestAvailable !== requested;
}

export { agentToday };
