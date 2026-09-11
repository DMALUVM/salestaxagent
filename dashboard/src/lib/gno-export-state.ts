/**
 * GNO pack due-state. The page banner is a state machine, not a how-to.
 *
 * EXPORT_NEEDED when a P0 is unacked, the 48h review is within 6h / overdue,
 * or (optional) the 06:30–08:00 ET digest window has new harvest/junk P1s.
 * Exporting acknowledges until a *new* P0 or the next review window.
 * Observe only — never writes to Amazon.
 */

import spec from "../../config/gno_ppc_watch.json";
import { AGENT_TZ, AMAZON_TZ } from "./as-of";
import { normalizeName, normalizeTerm, type GnoAlert } from "./gno-ppc-watch";

export const EXPORT_NEEDED = "EXPORT_NEEDED" as const;
export const QUIET = "QUIET" as const;
export type ExportBannerState = typeof EXPORT_NEEDED | typeof QUIET;
export type ExportReason = "P0" | "REVIEW" | "DIGEST" | "MANUAL";

const LEAD_HOURS = Number(spec.export_review_lead_hours ?? 6);
const DIGEST_START = spec.digest_window_et?.start ?? "06:30";
const DIGEST_END = spec.digest_window_et?.end ?? "08:00";

export interface GnoExportStateRow {
  id?: string;
  last_export_at?: string | null;
  last_export_reason?: string | null;
  last_export_filename?: string | null;
  acked_p0_keys?: string[] | null;
  acked_p1_keys?: string[] | null;
  updated_at?: string | null;
}

export interface ExportBanner {
  state: ExportBannerState;
  reasons: Exclude<ExportReason, "MANUAL">[];
  headline: string;
  lastExportAt: string | null;
  lastExportReason: string | null;
  nextReviewAt: string;
  nextReviewLabel: string;
  upcomingReviewAt: string;
  upcomingReviewLabel: string;
  reviewLine: string;
  hoursSinceExport: number | null;
  reviewDue: boolean;
  reviewOverdue: boolean;
  digestWindow: boolean;
}

/** Wednesday 18:00 America/Los_Angeles — Amazon/Ads desk TZ (original GNO_NEXT_REVIEW slot). */
export const GNO_REVIEW_TZ = AMAZON_TZ;
export const GNO_REVIEW_HOUR = 18;
export const GNO_REVIEW_WEEKDAY = 3; // Sun=0

export interface GnoReviewClock {
  thisWeekReviewAt: string;
  nextReviewAt: string;
  upcomingReviewAt: string;
  reviewOverdue: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function zonedParts(now: Date, tz: string): {
  y: number; m: number; d: number; weekday: number; hour: number; minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: wd,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export function instantAtZone(ymd: string, hour: number, minute: number, tz: string): Date {
  const wanted = `${ymd}T${pad2(hour)}:${pad2(minute)}:00`;
  let utc = Date.parse(`${wanted}Z`);
  for (let i = 0; i < 4; i++) {
    const z = zonedParts(new Date(utc), tz);
    const asLocal = Date.parse(
      `${z.y}-${pad2(z.m)}-${pad2(z.d)}T${pad2(z.hour)}:${pad2(z.minute)}:00Z`,
    );
    const delta = Date.parse(`${wanted}Z`) - asLocal;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function thisWeekWednesdayYmd(now: Date, tz = GNO_REVIEW_TZ): string {
  const z = zonedParts(now, tz);
  const ymd = `${z.y}-${pad2(z.m)}-${pad2(z.d)}`;
  const daysSinceWed = (z.weekday - GNO_REVIEW_WEEKDAY + 7) % 7;
  return addDaysYmd(ymd, -daysSinceWed);
}

export function toReviewIso(at: Date, tz = GNO_REVIEW_TZ): string {
  const z = zonedParts(at, tz);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT-07:00";
  const off = /GMT([+-]\d{2}:\d{2})/.exec(name)?.[1] ?? "-07:00";
  return `${z.y}-${pad2(z.m)}-${pad2(z.d)}T${pad2(GNO_REVIEW_HOUR)}:00:00${off}`;
}

function firstReviewAt(): Date {
  const launched = Date.parse(String(spec.launched_at ?? ""));
  const origin = Number.isFinite(launched) ? new Date(launched) : nowFallback();
  const ymd = thisWeekWednesdayYmd(origin);
  let wed = instantAtZone(ymd, GNO_REVIEW_HOUR, 0, GNO_REVIEW_TZ);
  if (wed.getTime() < origin.getTime()) {
    wed = instantAtZone(addDaysYmd(ymd, 7), GNO_REVIEW_HOUR, 0, GNO_REVIEW_TZ);
  }
  return wed;
}

function nowFallback(): Date {
  return new Date("2026-09-07T12:00:00-04:00");
}

function exportCovers(lastExportAt: string | null | undefined, windowStart: Date): boolean {
  const exported = lastExportAt ? Date.parse(lastExportAt) : Number.NaN;
  return Number.isFinite(exported) && exported >= windowStart.getTime();
}

/**
 * Live SoT for the weekly 48h harvest review.
 * Wednesday 6:00 PM America/Los_Angeles. A past config seed is ignored.
 * After an export that covers the owed Wed window, advance to the following Wednesday.
 */
export function resolveGnoReviewClock(
  now: Date,
  lastExportAt?: string | null,
  leadHours = LEAD_HOURS,
): GnoReviewClock {
  const thisYmd = thisWeekWednesdayYmd(now);
  const thisWed = instantAtZone(thisYmd, GNO_REVIEW_HOUR, 0, GNO_REVIEW_TZ);
  const lastWed = instantAtZone(addDaysYmd(thisYmd, -7), GNO_REVIEW_HOUR, 0, GNO_REVIEW_TZ);
  const nextWed = instantAtZone(addDaysYmd(thisYmd, 7), GNO_REVIEW_HOUR, 0, GNO_REVIEW_TZ);
  const thisWindow = new Date(thisWed.getTime() - leadHours * 3_600_000);
  const lastWindow = new Date(lastWed.getTime() - leadHours * 3_600_000);
  const first = firstReviewAt();
  const thisIso = toReviewIso(thisWed);
  const nextIso = toReviewIso(nextWed);
  const lastIso = toReviewIso(lastWed);

  if (now.getTime() < thisWindow.getTime()) {
    if (lastWed.getTime() >= first.getTime() && !exportCovers(lastExportAt, lastWindow)) {
      return {
        thisWeekReviewAt: lastIso,
        nextReviewAt: lastIso,
        upcomingReviewAt: thisIso,
        reviewOverdue: now.getTime() >= lastWed.getTime(),
      };
    }
    return {
      thisWeekReviewAt: thisIso,
      nextReviewAt: thisIso,
      upcomingReviewAt: thisIso,
      reviewOverdue: false,
    };
  }
  if (exportCovers(lastExportAt, thisWindow)) {
    return {
      thisWeekReviewAt: thisIso,
      nextReviewAt: nextIso,
      upcomingReviewAt: nextIso,
      reviewOverdue: false,
    };
  }
  return {
    thisWeekReviewAt: thisIso,
    nextReviewAt: thisIso,
    upcomingReviewAt: nextIso,
    reviewOverdue: now.getTime() >= thisWed.getTime(),
  };
}

export function p0Key(a: Pick<GnoAlert, "code" | "campaign_name" | "search_term">): string {
  return `${a.code}|${normalizeName(a.campaign_name)}|${normalizeTerm(a.search_term)}`;
}

export function p1HarvestJunkKey(
  a: Pick<GnoAlert, "code" | "search_term">,
): string {
  return `${a.code}|${normalizeTerm(a.search_term)}`;
}

export function isHarvestJunkP1(a: Pick<GnoAlert, "code">): boolean {
  return a.code === "HARVEST_CANDIDATE" || a.code === "JUNK_CANDIDATE";
}

export function reviewWindowStart(
  nextReviewAt: string,
  leadHours = LEAD_HOURS,
): Date | null {
  const t = Date.parse(nextReviewAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t - leadHours * 3_600_000);
}

export function isReviewDue(
  now: Date,
  nextReviewAt: string,
  lastExportAt: string | null | undefined,
  leadHours = LEAD_HOURS,
): boolean {
  const start = reviewWindowStart(nextReviewAt, leadHours);
  if (!start) return false;
  if (now.getTime() < start.getTime()) return false;
  if (!lastExportAt) return true;
  const exported = Date.parse(lastExportAt);
  if (!Number.isFinite(exported)) return true;
  return exported < start.getTime();
}

function clockInZone(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

export function isDigestWindow(
  now: Date,
  start = DIGEST_START,
  end = DIGEST_END,
  tz = AGENT_TZ,
): boolean {
  const clock = clockInZone(now, tz);
  return clock >= start && clock <= end;
}

export function formatHoursAgo(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function hoursSince(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

export function formatNextReview(nextReviewAt: string): string {
  const t = Date.parse(nextReviewAt);
  if (!Number.isFinite(t)) return nextReviewAt || "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AMAZON_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(t));
}

export function evaluateExportNeed(input: {
  now?: Date;
  nextReviewAt: string;
  upcomingReviewAt?: string;
  p0: Array<Pick<GnoAlert, "code" | "campaign_name" | "search_term">>;
  p1?: Array<Pick<GnoAlert, "code" | "search_term">>;
  lastExportAt?: string | null;
  lastExportReason?: string | null;
  ackedP0Keys?: string[] | null;
  ackedP1Keys?: string[] | null;
}): ExportBanner {
  const now = input.now ?? new Date();
  const ackedP0 = new Set(input.ackedP0Keys ?? []);
  const ackedP1 = new Set(input.ackedP1Keys ?? []);
  const openP0 = input.p0.filter((a) => !ackedP0.has(p0Key(a)));
  const newP1 = (input.p1 ?? [])
    .filter(isHarvestJunkP1)
    .filter((a) => !ackedP1.has(p1HarvestJunkKey(a)));
  const reviewDue = isReviewDue(now, input.nextReviewAt, input.lastExportAt);
  const digestWindow = isDigestWindow(now);
  const reviewTs = Date.parse(input.nextReviewAt);
  const reviewOverdue = reviewDue && Number.isFinite(reviewTs) && now.getTime() >= reviewTs;
  const upcomingReviewAt = input.upcomingReviewAt ?? input.nextReviewAt;

  const reasons: Exclude<ExportReason, "MANUAL">[] = [];
  if (openP0.length) reasons.push("P0");
  if (reviewDue) reasons.push("REVIEW");
  if (digestWindow && newP1.length) reasons.push("DIGEST");

  const ago = formatHoursAgo(input.lastExportAt, now);
  const hours = hoursSince(input.lastExportAt, now);
  const nextReviewLabel = formatNextReview(input.nextReviewAt);
  const upcomingReviewLabel = formatNextReview(upcomingReviewAt);
  const reviewLine = reviewOverdue
    ? `Wednesday review overdue — next scheduled ${upcomingReviewLabel}`
    : `Next human review: ${nextReviewLabel}`;

  let headline: string;
  if (reasons.length) {
    if (reviewOverdue && reasons.includes("REVIEW")) {
      headline = ago
        ? `Wednesday review overdue — last export ${ago}`
        : "Wednesday review overdue — needs export";
    } else {
      headline = ago ? `Pack due — last export ${ago}` : "Pack due — never exported";
    }
  } else {
    headline = ago ? `Up to date. Last export ${ago}.` : "Up to date. No pack due.";
  }

  return {
    state: reasons.length ? EXPORT_NEEDED : QUIET,
    reasons,
    headline,
    lastExportAt: input.lastExportAt ?? null,
    lastExportReason: input.lastExportReason ?? null,
    nextReviewAt: input.nextReviewAt,
    nextReviewLabel,
    upcomingReviewAt,
    upcomingReviewLabel,
    reviewLine,
    hoursSinceExport: hours,
    reviewDue,
    reviewOverdue,
    digestWindow,
  };
}

/** Banner from persisted export row + live Wednesday clock. Ads tiles optional. */
export function exportBannerFromState(
  exportState: GnoExportStateRow | null | undefined,
  extra: {
    now?: Date;
    p0?: Array<Pick<GnoAlert, "code" | "campaign_name" | "search_term">>;
    p1?: Array<Pick<GnoAlert, "code" | "search_term">>;
  } = {},
): ExportBanner {
  const now = extra.now ?? new Date();
  const clock = resolveGnoReviewClock(now, exportState?.last_export_at);
  return evaluateExportNeed({
    now,
    nextReviewAt: clock.nextReviewAt,
    upcomingReviewAt: clock.upcomingReviewAt,
    p0: extra.p0 ?? [],
    p1: extra.p1 ?? [],
    lastExportAt: exportState?.last_export_at,
    lastExportReason: exportState?.last_export_reason,
    ackedP0Keys: exportState?.acked_p0_keys,
    ackedP1Keys: exportState?.acked_p1_keys,
  });
}

export function mergeGnoAdsOntoState<T extends {
  lastExportAt?: string | null;
  lastExportReason?: string | null;
  nextReviewAt?: string;
  exportBanner?: ExportBanner;
}>(state: T | null | undefined, ads: T): T {
  return {
    ...ads,
    lastExportAt: ads.lastExportAt ?? state?.lastExportAt ?? null,
    lastExportReason: ads.lastExportReason ?? state?.lastExportReason ?? null,
    nextReviewAt: ads.nextReviewAt ?? state?.nextReviewAt,
    exportBanner: ads.exportBanner ?? state?.exportBanner,
  };
}

export function exportReasonOf(banner: ExportBanner): ExportReason {
  if (banner.reasons.includes("P0")) return "P0";
  if (banner.reasons.includes("REVIEW")) return "REVIEW";
  if (banner.reasons.includes("DIGEST")) return "DIGEST";
  return "MANUAL";
}

export function ackPayload(
  banner: ExportBanner,
  p0: Array<Pick<GnoAlert, "code" | "campaign_name" | "search_term">>,
  p1: Array<Pick<GnoAlert, "code" | "search_term">>,
  filename: string,
  exportedAt: Date = new Date(),
): {
  last_export_at: string;
  last_export_reason: ExportReason;
  last_export_filename: string;
  acked_p0_keys: string[];
  acked_p1_keys: string[];
  updated_at: string;
} {
  return {
    last_export_at: exportedAt.toISOString(),
    last_export_reason: exportReasonOf(banner),
    last_export_filename: filename,
    acked_p0_keys: p0.map(p0Key),
    acked_p1_keys: p1.filter(isHarvestJunkP1).map(p1HarvestJunkKey),
    updated_at: exportedAt.toISOString(),
  };
}
