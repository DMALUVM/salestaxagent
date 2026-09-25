/**
 * Jev shopper-funnel triage — Vercel twin of pilots/funnel_jev_triage.py.
 *
 * Protocol: wrap leak/abandon stats as {items:[...]} ; classify each item;
 * map to pursue | hold | skip (pursue if any pursue, else hold if any
 * hold/errors, else skip). Fail closed → hold.
 *
 * Runtime is Vercel only. AI_GATEWAY_API_KEY lives in the dashboard project
 * env / Secure Vault — never Mini .env, never NEXT_PUBLIC_, never logged.
 * Missing key → hold_for_review, no LLM. Silent → no LLM.
 * Does not mutate Shopify / theme / storefront.
 */

export const JEV_MODEL = "typesafe-ai/jev";
export const JEV_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

export const LEAK_Q = {
  severity: {
    type: "choice",
    instructions:
      "Tallowbourn Shopify conversion leak triage. " +
      "P0 = sudden cliff or large $ abandon spike needing Dave/ops eyes now; " +
      "P1 = meaningful drop-off worth Dashboard highlight; " +
      "P2 = normal noise / seasonal / already known kit friction.",
    criteria: {
      p0: "conversion cliff, checkout broken signal, or large $ abandon vs baseline",
      p1: "clear step leak (e.g. ATC→checkout or checkout→purchase) worth acting on",
      p2: "small move, noisy, or already explained",
    },
  },
  step: {
    type: "choice",
    instructions: "Which funnel step is the primary leak for this row?",
    criteria: {
      session_to_pdp: "land but don't view product",
      pdp_to_atc: "view product but don't add",
      atc_to_checkout: "cart but don't start checkout",
      checkout_to_purchase: "checkout started but don't buy",
      post_purchase: "not a pre-purchase leak",
      unclear: "can't tell from evidence",
    },
  },
  needs_dave: {
    type: "boolean",
    instructions:
      "Does Dave need to see this on the lock screen / morning note (vs Dashboard-only)?",
  },
} as const;

const STATE_KEYS = [
  "mode", "period", "step", "metric", "baseline", "current", "delta_pct",
  "abandon_count", "abandon_value", "product", "handle", "device", "channel",
  "path", "query", "campaign", "spend", "conversions", "impressions", "clicks",
  "evidence", "notes",
] as const;

export type JevItemMode = "leak" | "landing" | "seo" | "ads" | "abandon";

export type JevItem = {
  mode: JevItemMode;
  period?: string | null;
  step?: string | null;
  metric?: string | null;
  baseline?: number | null;
  current?: number | null;
  delta_pct?: number | null;
  abandon_count?: number | null;
  abandon_value?: number | null;
  path?: string | null;
  device?: string | null;
  query?: string | null;
  campaign?: string | null;
  spend?: number | null;
  conversions?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  sessions?: number | null;
  purchases?: number | null;
  position?: number | null;
  evidence?: { leak?: unknown; abandon?: unknown; landing?: unknown; seo?: unknown; ads?: unknown };
  notes?: string;
  severity?: string;
  score?: number;
};

export type JevAnswers = {
  severity?: { choice?: string; value?: string };
  step?: { choice?: string; value?: string };
  needs_dave?: { probability?: number };
};

export type JevBuckets = {
  pursue: unknown[];
  hold: unknown[];
  skip: unknown[];
  errors: Array<{ index: number; error: string }>;
};

export type JevResult = {
  ran: boolean;
  reason?: string;
  decision: "pursue" | "hold" | "skip" | null;
  severity?: "hold_for_review";
  runtime: "vercel";
  pursue_n?: number;
  hold_n?: number;
  skip_n?: number;
  error_n?: number;
  error?: string;
  /** Slim pursue rows for Conversion Digest improvements. Omitted when empty. */
  pursue?: unknown[];
};

export type EvaluateFn = (
  state: string,
  questions: typeof LEAK_Q,
) => Promise<{ answers?: JevAnswers }>;

export function hasGatewayKey(
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  return Boolean((env.AI_GATEWAY_API_KEY ?? "").trim());
}

export const SHOPIFY_LEAK_MIN_LOST = 10;
export const GA4_LANDING_MIN_LOST = 10;
export const GSC_MIN_IMPRESSIONS = 50;
export const ADS_MIN_SPEND = 5;
export const ADS_NEAR_ZERO_CONV = 0.5;
export const DIGEST_ABANDON_KIT_MIN = 40;
export const DIGEST_MAX_IMPROVEMENTS = 5;
export const DIGEST_MAX_PER_SOURCE = 2;

export function jevItemsFromStats(stats: Record<string, unknown> | null | undefined): JevItem[] {
  const leak = (stats?.leak && typeof stats.leak === "object" ? stats.leak : {}) as Record<string, unknown>;
  const abandon = (stats?.abandon && typeof stats.abandon === "object" ? stats.abandon : {}) as Record<string, unknown>;
  const window = (stats?.window && typeof stats.window === "object" ? stats.window : {}) as Record<string, unknown>;
  const stepFrom = typeof leak.from === "string" ? leak.from : null;
  const stepTo = typeof leak.to === "string" ? leak.to : null;
  const metric = stepFrom && stepTo ? `${stepFrom}->${stepTo}` : stepFrom;
  return [{
    mode: "leak",
    period: typeof window.end === "string" ? window.end : null,
    step: stepFrom,
    metric,
    baseline: null,
    current: typeof leak.lost === "number" ? leak.lost : null,
    delta_pct: typeof leak.rate === "number" ? leak.rate : null,
    abandon_count: typeof abandon.open === "number" ? abandon.open : null,
    abandon_value: typeof abandon.openValue === "number" ? abandon.openValue : null,
    evidence: { leak, abandon },
  }];
}

type LockedLeak = {
  from: string;
  to: string;
  lost: number;
  rate: number | null;
};

type LockedLanding = {
  path: string;
  device: string;
  sessions: number;
  purchases: number;
  lost: number;
  rate: number | null;
};

type LockedSeo = {
  key: string;
  kind?: "query" | "page";
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

type LockedAd = {
  campaign_id: string;
  campaign_name: string;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
};

/**
 * Day-locked digest candidates. Uses shopify_funnel_daily as_of leak,
 * not the Mini 7d last_stats window. Older GA4/GSC/Ads days must not
 * be passed in — callers filter to as_of first.
 */
export function jevItemsFromLockedDay(input: {
  asOf: string;
  leak?: LockedLeak | null;
  abandon?: { open?: number; openValue?: number } | null;
  landingDrops?: LockedLanding[] | null;
  seoQueries?: LockedSeo[] | null;
  ads?: LockedAd[] | null;
}): JevItem[] {
  const asOf = input.asOf;
  const out: JevItem[] = [];

  const leak = input.leak;
  if (leak && leak.lost >= SHOPIFY_LEAK_MIN_LOST && leak.from && leak.to) {
    const metric = `${leak.from}->${leak.to}`;
    out.push({
      mode: "leak",
      period: asOf,
      step: leakStepOf(leak.from, leak.to),
      metric,
      current: leak.lost,
      delta_pct: leak.rate,
      abandon_count: typeof input.abandon?.open === "number" ? input.abandon.open : null,
      abandon_value: typeof input.abandon?.openValue === "number" ? input.abandon.openValue : null,
      severity: leak.lost >= 50 || ((leak.rate ?? 0) >= 0.7 && leak.lost >= 20) ? "p0" : "p1",
      score: leak.lost * 2,
      evidence: { leak, abandon: input.abandon ?? {} },
    });
  }

  const abandonValue = typeof input.abandon?.openValue === "number" ? input.abandon.openValue : null;
  const abandonOpen = typeof input.abandon?.open === "number" ? input.abandon.open : null;
  if (abandonValue != null && abandonValue >= DIGEST_ABANDON_KIT_MIN) {
    out.push({
      mode: "abandon",
      period: asOf,
      step: "unclear",
      metric: "abandon_value",
      current: abandonValue,
      abandon_count: abandonOpen,
      abandon_value: abandonValue,
      severity: abandonValue >= 80 ? "p0" : "p1",
      score: abandonValue * 2,
      evidence: { abandon: input.abandon },
    });
  }

  for (const drop of input.landingDrops ?? []) {
    if (!drop.path || drop.lost < GA4_LANDING_MIN_LOST) continue;
    const device = drop.device || "";
    out.push({
      mode: "landing",
      period: asOf,
      step: "pdp_to_atc",
      metric: "landing",
      path: drop.path,
      device,
      current: drop.lost,
      delta_pct: drop.rate,
      sessions: drop.sessions,
      purchases: drop.purchases,
      severity: "p1",
      score: drop.lost,
      evidence: { landing: drop },
    });
  }

  for (const q of input.seoQueries ?? []) {
    if (!q.key || q.impressions == null || q.impressions < GSC_MIN_IMPRESSIONS) continue;
    const clicks = q.clicks;
    if (clicks == null) continue;
    const zeroClick = clicks === 0;
    const weakCtr = q.ctr != null && Number.isFinite(q.ctr) && q.ctr < 0.02 && q.impressions >= 100;
    const weakPos = q.position != null && Number.isFinite(q.position) && q.position >= 15 && clicks <= 1;
    if (!zeroClick && !weakCtr && !weakPos) continue;
    const kind = q.kind === "page" ? "page" : "query";
    out.push({
      mode: "seo",
      period: asOf,
      step: "unclear",
      metric: kind === "page" ? "gsc_page" : "gsc_query",
      query: q.key,
      impressions: q.impressions,
      clicks: clicks,
      position: q.position,
      current: q.impressions,
      severity: "p1",
      score: q.impressions + (zeroClick ? 25 : 0),
      evidence: { seo: q },
    });
  }

  for (const ad of input.ads ?? []) {
    const name = (ad.campaign_name || ad.campaign_id || "").trim();
    if (!name) continue;
    if (ad.spend == null || ad.spend < ADS_MIN_SPEND) continue;
    if (ad.conversions == null || ad.conversions >= ADS_NEAR_ZERO_CONV) continue;
    out.push({
      mode: "ads",
      period: asOf,
      step: "unclear",
      metric: "ads_spend",
      campaign: name,
      spend: ad.spend,
      conversions: ad.conversions,
      clicks: ad.clicks,
      current: ad.spend,
      severity: "p1",
      score: ad.spend * 3,
      evidence: { ads: ad },
    });
  }

  return out;
}

function leakStepOf(from: string, to: string): string {
  const key = `${from}->${to}`;
  if (key.includes("sessions") && (key.includes("pdp") || key.includes("add"))) {
    return from.includes("pdp") || to.includes("pdp") ? "session_to_pdp" : "pdp_to_atc";
  }
  if (key.includes("add") && key.includes("checkout")) return "atc_to_checkout";
  if (key.includes("checkout") && key.includes("purchase")) return "checkout_to_purchase";
  return "unclear";
}

/** Rank material items. Max few, max two per source. Empty when nothing material. */
export function rankDigestItems(items: JevItem[], max = DIGEST_MAX_IMPROVEMENTS): JevItem[] {
  const sorted = [...items].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0)
    || (b.current ?? 0) - (a.current ?? 0)
    || (a.mode || "").localeCompare(b.mode || ""));
  const used: Record<string, number> = {};
  const out: JevItem[] = [];
  for (const item of sorted) {
    const n = used[item.mode] ?? 0;
    if (n >= DIGEST_MAX_PER_SOURCE) continue;
    used[item.mode] = n + 1;
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function jevDecisionFromResult(parsed: JevBuckets | Record<string, unknown> | null): "pursue" | "hold" | "skip" {
  if (!parsed || typeof parsed !== "object") return "hold";
  const pursue = Array.isArray(parsed.pursue) ? parsed.pursue : [];
  const hold = Array.isArray(parsed.hold) ? parsed.hold : [];
  const skip = Array.isArray(parsed.skip) ? parsed.skip : [];
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  if (pursue.length) return "pursue";
  if (hold.length || errors.length) return "hold";
  if (skip.length) return "skip";
  return "hold";
}

export function itemState(item: Record<string, unknown>): string {
  const parts = STATE_KEYS
    .filter((k) => item[k] !== null && item[k] !== undefined && item[k] !== "")
    .map((k) => `${k}: ${typeof item[k] === "object" ? JSON.stringify(item[k]) : item[k]}`);
  return parts.join("\n") || JSON.stringify(item).slice(0, 2500);
}

export function choiceOf(ans: JevAnswers, key: "severity" | "step"): string {
  const a = ans[key] || {};
  return a.choice || a.value || "";
}

export function boolTrue(ans: JevAnswers, key: "needs_dave", thr = 0.5): boolean {
  const a = ans[key] || {};
  return Number(a.probability || 0) >= thr;
}

export function bucketItem(item: JevItem, answers: JevAnswers): "pursue" | "hold" | "skip" {
  const sev = choiceOf(answers, "severity") || "p2";
  if (sev === "p0" || (sev === "p1" && boolTrue(answers, "needs_dave"))) return "pursue";
  if (sev === "p2" && !boolTrue(answers, "needs_dave")) return "skip";
  return "hold";
}

export function holdClosed(reason: string, extra: Partial<JevResult> = {}): JevResult {
  return {
    ran: false,
    reason,
    decision: "hold",
    severity: "hold_for_review",
    runtime: "vercel",
    ...extra,
  };
}

export function statsAreSilent(stats: Record<string, unknown> | null | undefined): boolean {
  if (!stats) return false;
  if (stats.silent === true) return true;
  const jev = stats.jev && typeof stats.jev === "object"
    ? stats.jev as Record<string, unknown>
    : null;
  return jev?.reason === "silent";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** True when last_stats.jev already ran on Vercel (digest / cron can skip LLM). */
export function jevAlreadyRan(stats: Record<string, unknown> | null | undefined): boolean {
  const jev = stats && isRecord(stats.jev) ? stats.jev : null;
  return jev?.ran === true && jev?.runtime === "vercel";
}

/** Run Jev unless Mini stamped silent or a Vercel run is already persisted. */
export function shouldRunJev(
  stats: Record<string, unknown> | null | undefined,
  force = false,
): boolean {
  if (force) return true;
  if (!stats) return false;
  if (statsAreSilent(stats)) return false;
  if (jevAlreadyRan(stats)) return false;
  return true;
}

export function mergeJevIntoStats(
  stats: Record<string, unknown>,
  result: JevResult,
  at: Date = new Date(),
): Record<string, unknown> {
  return { ...stats, jev: { ...result, at: at.toISOString() } };
}

/**
 * Digest / cron shared path: read last_stats.jev or run + persist.
 * Fail closed (no LLM) when silent, key missing, or evaluate missing.
 */
export async function ensureFunnelJevTriage(opts: {
  stats: Record<string, unknown> | null | undefined;
  hasGatewayKey: boolean;
  evaluate?: EvaluateFn;
  force?: boolean;
  persist?: (merged: Record<string, unknown>, result: JevResult) => Promise<void>;
}): Promise<JevResult> {
  const { stats, hasGatewayKey: keyed, evaluate, force, persist } = opts;
  if (!force && jevAlreadyRan(stats) && isRecord(stats?.jev)) {
    const prev = stats.jev as JevResult;
    return {
      ran: true,
      decision: prev.decision ?? "hold",
      runtime: "vercel",
      reason: "already_ran",
      pursue_n: prev.pursue_n,
      hold_n: prev.hold_n,
      skip_n: prev.skip_n,
      error_n: prev.error_n,
      ...(Array.isArray(prev.pursue) ? { pursue: prev.pursue } : {}),
    };
  }
  const result = await runFunnelJevTriage({
    stats,
    hasGatewayKey: keyed,
    force,
    evaluate: keyed ? evaluate : undefined,
  });
  if (persist && stats) {
    try {
      await persist(mergeJevIntoStats(stats, result), result);
    } catch {
      /* Iris still gets this read's result; cron can retry the write. */
    }
  }
  return result;
}

export async function runFunnelJevTriage(opts: {
  stats: Record<string, unknown> | null | undefined;
  hasGatewayKey: boolean;
  evaluate?: EvaluateFn;
  force?: boolean;
}): Promise<JevResult> {
  const { stats, hasGatewayKey: keyed, evaluate, force } = opts;
  if (statsAreSilent(stats) && !force) {
    return { ran: false, reason: "silent", decision: null, runtime: "vercel" };
  }
  if (!stats) {
    return holdClosed("no_stats");
  }
  if (!keyed) {
    return holdClosed("missing_gateway_key");
  }
  if (!evaluate) {
    return holdClosed("missing_evaluate");
  }

  const items = jevItemsFromStats(stats);
  const buckets: JevBuckets = { pursue: [], hold: [], skip: [], errors: [] };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const out = await evaluate(itemState(item as unknown as Record<string, unknown>), LEAK_Q);
      const answers = out.answers || {};
      const row = { ...item, jev: answers, mode: "leak" as const };
      const dest = bucketItem(item, answers);
      buckets[dest].push(row);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      buckets.hold.push({ ...item, jev_error: msg, mode: "leak" });
      buckets.errors.push({ index: i, error: msg.slice(0, 200) });
    }
  }
  const decision = jevDecisionFromResult(buckets);
  return {
    ran: true,
    decision,
    runtime: "vercel",
    pursue_n: buckets.pursue.length,
    hold_n: buckets.hold.length,
    skip_n: buckets.skip.length,
    error_n: buckets.errors.length,
    ...(buckets.pursue.length ? { pursue: buckets.pursue.slice(0, 3) } : {}),
    ...(buckets.errors.length && decision !== "pursue"
      ? { severity: "hold_for_review" as const }
      : {}),
  };
}

/** Call typesafe-ai/jev via AI Gateway. Never logs the key. */
export async function evaluateViaGateway(
  state: string,
  questions: typeof LEAK_Q,
  fetchImpl: typeof fetch = fetch,
): Promise<{ answers?: JevAnswers }> {
  const key = (process.env.AI_GATEWAY_API_KEY ?? "").trim();
  if (!key) {
    throw new Error("AI_GATEWAY_API_KEY not available");
  }
  const res = await fetchImpl(JEV_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are Jev. Evaluate the shopper-funnel state against the questions. " +
            "Reply with JSON only: " +
            '{"answers":{"severity":{"choice":"p0|p1|p2"},' +
            '"step":{"choice":"session_to_pdp|pdp_to_atc|atc_to_checkout|checkout_to_purchase|post_purchase|unclear"},' +
            '"needs_dave":{"probability":0..1}}}.',
        },
        { role: "user", content: JSON.stringify({ state, questions }) },
      ],
      response_format: { type: "json_object" },
      // Every call requires ZDR. Gateway returns 400 no_providers_available
      // when no ZDR provider can serve the model; that is a normal gateway
      // error below — never retry without this flag.
      providerOptions: {
        gateway: { zeroDataRetention: true },
      },
    }),
  });
  const raw = await res.text();
  const redacted = key ? raw.split(key).join("[REDACTED]") : raw;
  if (!res.ok) {
    throw new Error(`jev gateway ${res.status}: ${redacted.slice(0, 180)}`);
  }
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = JSON.parse(redacted);
  } catch {
    throw new Error("jev gateway invalid_json");
  }
  const content = parsed.choices?.[0]?.message?.content ?? redacted;
  const body = typeof content === "string" ? JSON.parse(content) : content;
  if (!body || typeof body !== "object") {
    throw new Error("jev gateway empty");
  }
  return body.answers ? body : { answers: body };
}
