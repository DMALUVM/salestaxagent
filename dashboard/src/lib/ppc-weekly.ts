/**
 * This week's /ppc execute list.
 *
 * Empty until ads_search_terms_daily covers SEARCH_TERM_EXECUTE_MIN_DAYS
 * (80d of a 90d Sunday pull). Do not ship the stored 24d window as an
 * execute list. buildBlake24dList stays a library. Nothing writes to Amazon.
 *
 * When a row is later marked Done (applied) or Skipped (dismissed), the
 * same campaign+term+action stays locked for 7 days via applied_at /
 * dismissed_at. Still-$0 bleeders may reappear.
 */

export const WEEKLY_ACTIONS = [
  "pause_keyword",
  "negative_exact",
  "bid_down",
  "bid_up",
  "cut_detail_page",
  "raise_tos",
  "cut_ros",
  "harvest_exact",
  "brand_defense",
] as const;

export type WeeklyAction = (typeof WEEKLY_ACTIONS)[number];

export const WEEKLY_REC_TYPES: Record<WeeklyAction, string> = {
  pause_keyword: "WEEKLY_PAUSE_KEYWORD",
  negative_exact: "WEEKLY_NEGATIVE_EXACT",
  bid_down: "WEEKLY_BID_DOWN",
  bid_up: "WEEKLY_BID_UP",
  cut_detail_page: "WEEKLY_CUT_DETAIL_PAGE",
  raise_tos: "WEEKLY_RAISE_TOS",
  cut_ros: "WEEKLY_CUT_ROS",
  harvest_exact: "WEEKLY_HARVEST_EXACT",
  brand_defense: "WEEKLY_BRAND_DEFENSE",
};

export const WEEKLY_CSV_HEADERS = [
  "id", "rank", "action", "campaign", "ad_group", "term", "match_type",
  "clicks", "spend", "sales", "acos", "term_cvr", "account_cvr_lane",
  "current_bid", "new_bid", "placement", "window", "why",
] as const;

/** Sunday job requests 90d. 80d is the floor so a short landing still
 *  counts as "90d present"; the stored 24d window does not. */
export const SEARCH_TERM_EXECUTE_MIN_DAYS = 80;

export const WEEKLY_LOCK_DAYS = 7;

export const NEW_BID_DOWN_FACTOR = 0.42;
export const NEW_BID_UP_FACTOR = 1.15;

export type WeeklyStatus = "open" | "done" | "skipped";

export interface WeeklyWindow {
  start: string;
  end: string;
  days: number;
  days_with_rows: number;
  label: string;
}

export interface WeeklyRow {
  id: string;
  rank: string;
  action: WeeklyAction;
  campaign: string;
  campaign_id: string;
  ad_group: string;
  term: string;
  match_type: string;
  clicks: number;
  spend: number;
  sales: number;
  acos: number | null;
  term_cvr: number | null;
  account_cvr_lane: number | null;
  current_bid: null;
  new_bid: number | null;
  placement: string | null;
  window: string;
  why: string;
  status: WeeklyStatus;
  decision_id: string | null;
}

export interface WeeklyLockDecision {
  id?: string | null;
  campaign_id?: string | null;
  search_term?: string | null;
  action_type?: string | null;
  status?: string | null;
  applied_at?: string | null;
  dismissed_at?: string | null;
}

export type ExecuteList = "empty" | "blake_24d";

export interface WeeklyPayload {
  execute_ready: boolean;
  execute_list: ExecuteList;
  window_chip?: string;
  window: {
    search: WeeklyWindow;
    placement: WeeklyWindow | null;
  };
  account_cvr: number;
  account_cvr_source: "ads_campaigns_daily";
  account_cvr_branded: number | null;
  account_cvr_nonbranded: number | null;
  lane_cvr_source: "ads_search_terms_daily + brand_terms.json";
  click_floor: number;
  open_count: number;
  done_count: number;
  skipped_count: number;
  search_term_coverage: "SP-only";
  notes: string[];
  cadence: string[];
  hold: string[];
  grok_prompt: string;
  new_bid: { down: string; up: string; current_bid: null };
  lock: { days: number; exception: string };
  rows: WeeklyRow[];
}

export const WEEKLY_CADENCE = [
  "Weekly list = one Monday pass. Do not churn mid-week.",
  "Harvest every other week.",
  "Monthly extras (TOS / brand defense / placement extras) first Monday.",
] as const;

export const WEEKLY_HOLD = [
  "Do not raise TOS on Hero Exact or Auto Loose.",
  "Do not harvest Aquaphor or Carpe.",
  "organic lip balm / lip balm organic = bid_down, not pause.",
] as const;

/** Empty-until-90d standing prompt. Copy Grok must not use this when
 *  execute_list === "blake_24d" — Dave unlocked the 24d pass. */
export const STANDING_GROK_PROMPT = [
  "You are ranking THIS WEEK's Amazon PPC execute list for Tallowbourn.",
  "Do not invent rows. Wait for ads_search_terms_daily min/max after the Sunday 90d search-term pull. Do not use the stored 24d window as an execute list.",
  "One Monday pass only — no mid-week churn. Harvest every other week. Monthly extras first Monday.",
  "Nothing writes to Amazon. Dave marks Done or Skipped after Campaign Manager.",
].join("\n");

export const WEEKLY_GROK_PROMPT = [
  "You are ranking THIS WEEK's Amazon PPC execute list for Tallowbourn.",
  "The pasted CSV from This week IS the execute list for this pass.",
  "Window is 2026-08-06..08-29 (24d). Do not refuse rows because the window is 24d. Do not wait for 90d. Do not say \"no execute list this pass.\"",
  "One row = one Amazon click in Seller Central. Then Dave marks Done or Skipped on the This week card.",
  "Nothing writes to Amazon.",
  "HOLD: no TOS raise on Hero Exact / Auto Loose; no Aquaphor/Carpe harvest; organic lip balm / lip balm organic = bid_down not pause.",
  "Actions allowed: pause_keyword, negative_exact, bid_down, bid_up, cut_detail_page, raise_tos, cut_ros, harvest_exact, brand_defense.",
  "Cut bleeders on term CVR below that row's lane account CVR (branded vs non-branded from brand_terms.json), not clicks>10 and sales=$0-only. Click floor from blended account CVR: <4% → 25; 5–10% incl. → 15; else 10. 10/$0 is a flag, not the only filter.",
  "current_bid is always blank (no bid column in Dashboard). new_bid down = CPC × 0.42 / ACOS (ACOS = spend/sales). new_bid up = CPC × 1.15.",
  "After Done or Skipped, do not re-open the same campaign+term+action for 7 days (applied_at / dismissed_at). Exception: still-$0 bleeders may reappear.",
  "Search-term reports are SP-only. Do not invent a keyword or product-target daily table. Placement grain is campaign+placement from ads_placement_daily.",
  "CSV columns: id, rank, action, campaign, ad_group, term, match_type, clicks, spend, sales, acos, term_cvr, account_cvr_lane, current_bid, new_bid, placement, window, why.",
].join("\n");

/** blake_24d copies the 24d execute prompt; empty uses the standing wait. */
export function grokPromptFor(executeList: ExecuteList): string {
  if (executeList === "blake_24d") return WEEKLY_GROK_PROMPT;
  return STANDING_GROK_PROMPT;
}

export function cvrPct(orders: number, clicks: number): number | null {
  if (clicks <= 0) return null;
  return (orders / clicks) * 100;
}

/** GNO click floor from blended account CVR. */
export function clickFloor(accountCvrPct: number): number {
  if (accountCvrPct < 4) return 25;
  if (accountCvrPct >= 5 && accountCvrPct <= 10) return 15;
  return 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function inclusiveDays(start: string, end: string): number {
  const a = Date.parse(`${start}T12:00:00Z`);
  const b = Date.parse(`${end}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function storedWindow(dates: string[]): WeeklyWindow {
  const clean = dates.map((d) => String(d ?? "")).filter(Boolean).sort();
  if (clean.length === 0) {
    return {
      start: "", end: "", days: 0, days_with_rows: 0,
      label: "No rows stored",
    };
  }
  const start = clean[0];
  const end = clean[clean.length - 1];
  const days = inclusiveDays(start, end);
  const daysWithRows = new Set(clean).size;
  return {
    start,
    end,
    days,
    days_with_rows: daysWithRows,
    label: `${start} → ${end} · ${days}d stored (not 60d, not a fake 90d)`,
  };
}

export function isExecuteWindowReady(windowDays: number): boolean {
  return windowDays >= SEARCH_TERM_EXECUTE_MIN_DAYS;
}

export function recTypeOfWeekly(action: WeeklyAction): string {
  return WEEKLY_REC_TYPES[action];
}

/** ACOS is spend/sales (0.35, not 35). */
export function newBidDown(cpc: number, acosRatio: number): number | null {
  if (!(cpc > 0) || !(acosRatio > 0)) return null;
  return round2(cpc * NEW_BID_DOWN_FACTOR / acosRatio);
}

export function newBidDownFromAcosPct(cpc: number, acosPct: number): number | null {
  if (!(acosPct > 0)) return null;
  return newBidDown(cpc, acosPct / 100);
}

export function newBidUp(cpc: number): number | null {
  if (!(cpc > 0)) return null;
  return round2(cpc * NEW_BID_UP_FACTOR);
}

export function weeklyLockKey(campaignId: string, term: string, action: string): string {
  return [
    String(campaignId ?? "").trim().toLowerCase(),
    String(term ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    String(action ?? "").trim().toLowerCase(),
  ].join("\u241F");
}

export function lockTimestamp(d: WeeklyLockDecision): string | null {
  const status = String(d.status ?? "");
  if (status === "applied" && d.applied_at) return String(d.applied_at);
  if (status === "dismissed" && d.dismissed_at) return String(d.dismissed_at);
  if (status === "applied") return d.applied_at ? String(d.applied_at) : null;
  if (status === "dismissed") return d.dismissed_at ? String(d.dismissed_at) : null;
  return null;
}

/**
 * True when the same campaign+term+action was Done/Skipped in the last 7d
 * and must not be re-opened. Still-$0 bleeders are never locked.
 */
export function isWeeklyLocked(
  decision: WeeklyLockDecision | undefined,
  now: Date,
  sales: number,
): boolean {
  if (!decision) return false;
  if (sales <= 0) return false;
  const status = String(decision.status ?? "");
  if (status !== "applied" && status !== "dismissed") return false;
  const ts = lockTimestamp(decision);
  if (!ts) return false;
  const lockedAt = Date.parse(ts);
  if (!Number.isFinite(lockedAt)) return false;
  const ageMs = now.getTime() - lockedAt;
  return ageMs >= 0 && ageMs < WEEKLY_LOCK_DAYS * 86_400_000;
}

export function shouldSkipRegeneration(
  prior: WeeklyLockDecision | undefined,
  now: Date,
  sales: number,
): boolean {
  return isWeeklyLocked(prior, now, sales);
}

export function applyWeeklyLocks<T extends {
  campaign_id: string;
  campaign?: string;
  term?: string;
  action: string;
  sales: number;
  status: WeeklyStatus;
  decision_id?: string | null;
}>(
  rows: T[],
  decisions: WeeklyLockDecision[],
  now: Date = new Date(),
): T[] {
  const byKey = new Map<string, WeeklyLockDecision>();
  for (const d of decisions) {
    const key = weeklyLockKey(
      String(d.campaign_id ?? ""),
      String(d.search_term ?? ""),
      String(d.action_type ?? ""),
    );
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, d);
      continue;
    }
    const prevTs = Date.parse(lockTimestamp(prev) ?? "") || 0;
    const nextTs = Date.parse(lockTimestamp(d) ?? "") || 0;
    if (nextTs >= prevTs) byKey.set(key, d);
  }

  return rows.map((row) => {
    const prior = byKey.get(weeklyLockKey(row.campaign_id, row.term ?? "", row.action))
      ?? byKey.get(weeklyLockKey(row.campaign ?? "", row.term ?? "", row.action));
    if (!isWeeklyLocked(prior, now, row.sales)) return row;
    const skipped = String(prior?.status ?? "") === "dismissed";
    return {
      ...row,
      status: (skipped ? "skipped" : "done") as T["status"],
      decision_id: prior?.id ? String(prior.id) : row.decision_id ?? null,
    };
  });
}

function emptySearchWindow(): WeeklyWindow {
  return storedWindow([]);
}

export function emptyWeeklyList(partial?: {
  search?: WeeklyWindow;
  placement?: WeeklyWindow | null;
  account_cvr?: number;
  account_cvr_branded?: number | null;
  account_cvr_nonbranded?: number | null;
  click_floor?: number;
}): WeeklyPayload {
  const search = partial?.search ?? emptySearchWindow();
  const placement = partial?.placement ?? null;
  const ready = isExecuteWindowReady(search.days);
  const notes = ready
    ? [
        `Search terms stored ${search.start} → ${search.end} (${search.days} calendar days, ${search.days_with_rows} days with rows). 90d window is present — execute list stays empty until Blake ranks. No auto-seed.`,
        "Search-term reports are SP-only. SB/SD terms will be thin or missing.",
        "Checking Done or Skipped records applied/dismissed on ads_action_decisions. Nothing writes to Amazon.",
      ]
    : [
        search.days > 0
          ? `Search terms stored ${search.start} → ${search.end} (${search.days} calendar days, ${search.days_with_rows} days with rows). Not 90d — no execute list. Sunday 03:30 ET 90d search-term backfill must land and Dana's min/max must move first. Weekday ingest stays 7d.`
          : "No search-term rows stored. Sunday 03:30 ET 90d search-term backfill must land before Blake ranks. Weekday ingest stays 7d.",
        "Search-term reports are SP-only. SB/SD terms will be thin or missing. Do not invent 60d or 90d coverage.",
        "Checking Done or Skipped records applied/dismissed on ads_action_decisions. Nothing writes to Amazon.",
      ];
  if (placement && placement.days > 0) {
    notes.push(
      `Placements stored ${placement.start} → ${placement.end} (${placement.days} calendar days). Coverage only — not an execute list.`,
    );
  }
  return {
    execute_ready: ready,
    execute_list: "empty",
    window: { search, placement },
    account_cvr: partial?.account_cvr ?? 0,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: partial?.account_cvr_branded ?? null,
    account_cvr_nonbranded: partial?.account_cvr_nonbranded ?? null,
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: partial?.click_floor ?? 10,
    open_count: 0,
    done_count: 0,
    skipped_count: 0,
    search_term_coverage: "SP-only",
    notes,
    cadence: [...WEEKLY_CADENCE],
    hold: [...WEEKLY_HOLD],
    grok_prompt: grokPromptFor("empty"),
    new_bid: {
      down: "CPC × 0.42 / ACOS (ACOS = spend/sales)",
      up: "CPC × 1.15",
      current_bid: null,
    },
    lock: {
      days: WEEKLY_LOCK_DAYS,
      exception: "still-$0 bleeders may reappear",
    },
    rows: [],
  };
}

export function weeklyToCsv(rows: WeeklyRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [WEEKLY_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(WEEKLY_CSV_HEADERS.map((h) => esc(r[h])).join(","));
  }
  return lines.join("\n");
}
