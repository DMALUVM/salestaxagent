/**
 * Conversion Digest — stable read-only JSON for Iris (Dana owns numbers).
 *
 * Date-lock: as_of is a closed America/New_York day. Default is yesterday ET.
 * Never substitute an older complete day when the requested day is missing.
 *
 * Funnel / primary_leak / abandons: shopify_funnel_* only.
 * improvements: ranked as_of actions (max 5). Morgan/CoS locked schema:
 * owner (one of Harry|Nora|Blake|Blair|Kit), severity, evidence, concrete_ask,
 * dave_tap, rank, text. One owner. Ban “fix PDP/ATC”. Meta stays on
 * phase2.meta (Iris Morning Brief); this ranked list is Google/Blake,
 * Shopify, GSC, and GA4.
 * Empty when nothing material. Never invents metrics.
 */

import { agentAsOf, agentToday } from "./as-of";
import {
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

export const DIGEST_OWNERS = ["Harry", "Nora", "Blake", "Blair", "Kit"] as const;
export type DigestOwner = (typeof DIGEST_OWNERS)[number];

/** Generic copy Morgan banned. concrete_ask / text must not match. */
export const IMPROVEMENT_BAN = [
  /fix PDP\/ATC/i,
  /fix pdp\/atc/i,
] as const;

export type DigestEvidence = {
  source: "ga4" | "gsc" | "ads" | "shopify";
  path?: string;
  device?: string;
  query?: string;
  page?: string;
  campaign?: string;
  sessions?: number;
  purchases?: number;
  lost?: number;
  impressions?: number;
  clicks?: number;
  position?: number;
  spend?: number;
  conversions?: number;
  abandon_value?: number;
  abandon_count?: number;
  rate?: number;
};

export type DigestImprovement = {
  rank: number;
  text: string;
  owner: DigestOwner;
  severity: string;
  evidence: DigestEvidence;
  concrete_ask: string;
  dave_tap: boolean;
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
    const leak = row.evidence && typeof row.evidence === "object"
      ? (row.evidence as { leak?: Record<string, unknown> }).leak
      : undefined;
    const lost = typeof row.current === "number" ? row.current
      : typeof leak?.lost === "number" ? leak.lost
      : null;
    const built = improvementFromAction({
      mode: "leak",
      metric: typeof row.metric === "string" ? row.metric : null,
      current: lost,
      step: stepChoice || "unclear",
      severity: sevChoice || "p1",
    });
    if (!built) continue;
    built.rank = out.length + 1;
    out.push(built);
  }
  return out;
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

function pathNorm(path: string | null | undefined): string {
  if (!path) return "";
  return path.toLowerCase().split("?")[0].replace(/\/+$/, "") || "/";
}

/** Blair only for checkout theme or theme/bug paths. Collections stay Harry. */
export function isBlairThemeBugPath(path: string | null | undefined): boolean {
  const p = pathNorm(path);
  if (!p || /\/products?\//.test(p)) return false;
  return /^\/(checkouts?)(\/|$)/.test(p)
    || /theme|layout|template/.test(p)
    || /^\/apps(\/|$)/.test(p);
}

export function isThemeLayoutPath(path: string | null | undefined): boolean {
  return isBlairThemeBugPath(path);
}

export function ownerForAction(item: JevItem): DigestOwner | null {
  if (item.mode === "landing") {
    return isBlairThemeBugPath(item.path) ? "Blair" : "Harry";
  }
  if (item.mode === "seo") return "Nora";
  if (item.mode === "ads") return "Blake";
  if (item.mode === "abandon") return "Kit";
  if (item.mode === "leak") {
    if (item.step === "checkout_to_purchase") return "Blair";
    return "Harry";
  }
  return null;
}

/** Dave only for money / recover-sends / a real fork. Not routine copy or SEO. */
export function daveTapForAction(item: JevItem, severity: string): boolean {
  if (item.mode === "abandon") return true;
  if (item.mode === "ads" && item.spend != null && item.spend >= 50) return true;
  if (severity === "P0" && item.mode === "ads") return true;
  return false;
}

function normalizeSeverity(raw: string | undefined): string {
  const s = (raw || "p1").trim();
  const up = s.toUpperCase();
  if (up === "P0" || up === "P1" || up === "P2") return up;
  return s;
}

function benefitFromPath(path: string): string | null {
  const slug = path.split("/").filter(Boolean).pop() ?? "";
  if (!slug) return null;
  const tokens = slug.split(/[-_]/).filter(Boolean);
  if (!tokens.length) return null;
  const joined = tokens.map((t) => t.toLowerCase()).join(" ");
  if (/\bextra\b/.test(joined) && /\bstrength\b/.test(joined)) return "Extra Strength";
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
}

function leakAsk(step: string): string {
  if (step === "session_to_pdp") return "move sessions onto a PDP before the offer";
  if (step === "pdp_to_atc") return "rewrite PDP CTA and simplify ATC";
  if (step === "atc_to_checkout") return "cut cart-to-checkout friction";
  if (step === "checkout_to_purchase") return "repair checkout theme so started checkouts complete";
  return "act on the closed-funnel step with the lost-session count";
}

function landingAsk(path: string): string {
  if (/\/products?\//i.test(path)) {
    const benefit = benefitFromPath(path);
    if (benefit) return `rewrite above-fold CTA to ${benefit} benefit + simplify ATC`;
    return "rewrite above-fold CTA to the product benefit + simplify ATC";
  }
  if (isBlairThemeBugPath(path)) return "repair checkout or theme bug on this path";
  return "rewrite above-fold CTA and simplify the next click";
}

function seoAsk(item: JevItem): string {
  const kind = item.metric === "gsc_page" ? "page" : "query";
  if (item.clicks === 0) return `rewrite title and meta for this ${kind} gap`;
  if (item.position != null && Number.isFinite(item.position) && item.position >= 15) {
    return `rewrite title and meta to climb this ${kind}`;
  }
  return `rewrite title and meta for this ${kind}`;
}

function pick<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (v === undefined || v === null || v === "") delete (out as Record<string, unknown>)[k];
  }
  return out;
}

function evidenceFor(item: JevItem): DigestEvidence | null {
  if (item.mode === "landing") {
    if (!item.path || item.current == null) return null;
    return pick({
      source: "ga4" as const,
      path: item.path,
      device: item.device || undefined,
      sessions: item.sessions ?? undefined,
      purchases: item.purchases ?? undefined,
      lost: item.current,
      rate: item.delta_pct ?? undefined,
    });
  }
  if (item.mode === "seo") {
    if (!item.query || item.impressions == null || item.clicks == null) return null;
    const page = item.metric === "gsc_page";
    return pick({
      source: "gsc" as const,
      query: page ? undefined : item.query,
      page: page ? item.query : undefined,
      impressions: item.impressions,
      clicks: item.clicks,
      position: item.position ?? undefined,
    });
  }
  if (item.mode === "ads") {
    if (!item.campaign || item.spend == null || item.conversions == null) return null;
    return pick({
      source: "ads" as const,
      campaign: item.campaign,
      spend: item.spend,
      clicks: item.clicks ?? undefined,
      conversions: item.conversions,
    });
  }
  if (item.mode === "abandon") {
    if (item.abandon_value == null) return null;
    return pick({
      source: "shopify" as const,
      abandon_value: item.abandon_value,
      abandon_count: item.abandon_count ?? undefined,
    });
  }
  if (item.mode === "leak") {
    if (item.current == null) return null;
    return pick({
      source: "shopify" as const,
      lost: item.current,
      rate: item.delta_pct ?? undefined,
    });
  }
  return null;
}

function ownerCountInText(text: string): number {
  return (text.match(/\[(Harry|Nora|Blake|Blair|Kit)\]/g) || []).length;
}

export function improvementContractErrors(row: DigestImprovement): string[] {
  const errs: string[] = [];
  if (!DIGEST_OWNERS.includes(row.owner)) errs.push("owner");
  if (!row.severity) errs.push("severity");
  if (!row.evidence || typeof row.evidence !== "object" || Array.isArray(row.evidence)) {
    errs.push("evidence");
  } else if (!row.evidence.source) {
    errs.push("evidence.source");
  }
  if (!row.concrete_ask || !row.concrete_ask.trim()) errs.push("concrete_ask");
  if (typeof row.dave_tap !== "boolean") errs.push("dave_tap");
  if (typeof row.rank !== "number") errs.push("rank");
  if (!row.text || !row.text.trim()) errs.push("text");
  if (row.concrete_ask && ownerCountInText(row.concrete_ask) > 1) errs.push("multi_owner");
  if (row.text && ownerCountInText(row.text) > 1) errs.push("multi_owner");
  const banned = [...IMPROVEMENT_BAN];
  for (const re of banned) {
    if (re.test(row.concrete_ask || "") || re.test(row.text || "")) errs.push("ban");
  }
  if (row.owner === "Kit" && row.evidence?.source && row.evidence.source !== "shopify") {
    errs.push("owner_source");
  }
  return [...new Set(errs)];
}

export function improvementFromAction(item: JevItem): DigestImprovement | null {
  const owner = ownerForAction(item);
  const step = item.step || "unclear";
  const severity = normalizeSeverity(item.severity);
  const evidence = evidenceFor(item);
  if (!owner || !evidence) return null;
  const tag = `[${owner}]`;
  let ask: string | null = null;
  if (item.mode === "leak") {
    const metric = (item.metric || step).replace(/->/g, "→");
    const lost = item.current;
    if (!metric || lost == null) return null;
    const bits = [`${lost} sessions lost`];
    const pct = fmtPct(item.delta_pct);
    if (pct) bits[0] += ` (${pct})`;
    ask = `Shopify ${metric}: ${bits.join(" · ")} — ${leakAsk(step)} ${tag}`;
  } else if (item.mode === "abandon") {
    if (item.abandon_value == null) return null;
    const n = item.abandon_count;
    const countBit = n != null ? ` / ${n} checkout${n === 1 ? "" : "s"}` : "";
    ask = `Shopify abandons: $${fmtMoney(item.abandon_value)} open${countBit} — send recover sequence ${tag}`;
  } else if (item.mode === "landing") {
    const path = (item.path || "").trim();
    if (!path || item.current == null) return null;
    const device = titleCaseDevice(item.device || "");
    const head = [device, path].filter(Boolean).join(" ");
    let metric: string;
    if (item.sessions != null && item.purchases != null) {
      metric = `${item.sessions} sessions → ${item.purchases} purchases`;
    } else {
      metric = `${item.current} lost sessions`;
      const pct = fmtPct(item.delta_pct);
      if (pct) metric += ` (${pct})`;
    }
    ask = `${head}: ${metric} — ${landingAsk(path)} ${tag}`;
  } else if (item.mode === "seo") {
    const key = (item.query || "").trim();
    if (!key || item.impressions == null || item.clicks == null) return null;
    const kind = item.metric === "gsc_page" ? "page" : "query";
    const label = kind === "page" ? `GSC page ${key}` : `GSC query '${key}'`;
    const bits = [`${item.impressions} impr`, `${item.clicks} clicks`];
    if (item.position != null && Number.isFinite(item.position)) {
      bits.push(`pos ${fmtPos(item.position)}`);
    }
    ask = `${label}: ${bits.join(" / ")} — ${seoAsk(item)} ${tag}`;
  } else if (item.mode === "ads") {
    const campaign = (item.campaign || "").trim();
    if (!campaign || item.spend == null || item.conversions == null) return null;
    const bits = [`$${fmtMoney(item.spend)}`];
    if (item.clicks != null) bits.push(`${item.clicks} clicks`);
    bits.push(`${fmtConv(item.conversions)} conv`);
    ask = `Ads ${campaign}: ${bits.join(" / ")} — review negatives or pause ${tag}`;
  }
  if (!ask) return null;
  const row: DigestImprovement = {
    rank: 0,
    text: ask,
    owner,
    severity,
    evidence,
    concrete_ask: ask,
    dave_tap: daveTapForAction(item, severity),
    step,
  };
  if (improvementContractErrors(row).length) return null;
  return row;
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
  // Google waste only. Meta pause lines stay on phase2.meta.actions.
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
