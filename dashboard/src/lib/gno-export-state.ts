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
  hoursSinceExport: number | null;
  reviewDue: boolean;
  digestWindow: boolean;
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

  const reasons: Exclude<ExportReason, "MANUAL">[] = [];
  if (openP0.length) reasons.push("P0");
  if (reviewDue) reasons.push("REVIEW");
  if (digestWindow && newP1.length) reasons.push("DIGEST");

  const ago = formatHoursAgo(input.lastExportAt, now);
  const hours = hoursSince(input.lastExportAt, now);
  const nextReviewLabel = formatNextReview(input.nextReviewAt);

  if (reasons.length) {
    return {
      state: EXPORT_NEEDED,
      reasons,
      headline: ago ? `Pack due — last export ${ago}` : "Pack due — never exported",
      lastExportAt: input.lastExportAt ?? null,
      lastExportReason: input.lastExportReason ?? null,
      nextReviewAt: input.nextReviewAt,
      nextReviewLabel,
      hoursSinceExport: hours,
      reviewDue,
      digestWindow,
    };
  }

  return {
    state: QUIET,
    reasons: [],
    headline: ago ? `Up to date. Last export ${ago}.` : "Up to date. No pack due.",
    lastExportAt: input.lastExportAt ?? null,
    lastExportReason: input.lastExportReason ?? null,
    nextReviewAt: input.nextReviewAt,
    nextReviewLabel,
    hoursSinceExport: hours,
    reviewDue,
    digestWindow,
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
