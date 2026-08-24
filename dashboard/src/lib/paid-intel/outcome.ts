/**
 * Outcome loop.
 *
 * "I did this" is only worth recording if something checks whether it worked.
 * Every card declares an `IntelCheck` — one number, a direction, and the value
 * that counts as a pass. When the card is applied we store that number as the
 * baseline. On the next upload with a newer as-of we measure it again and grade
 * the change, so a card can read "worked" or "no change" instead of just "done".
 */
import { round4 } from "./csv";
import type {
  CampaignAgg, GaDaily, IntelCheck, IntelOutcome, OutcomeVerdict, PlatformKpis,
  SearchQueryDaily,
} from "./types";

export interface MeasureContext {
  camps: CampaignAgg[];
  ga: GaDaily[];
  queries: SearchQueryDaily[];
  google: PlatformKpis;
  meta: PlatformKpis;
  blended: PlatformKpis;
}

/** Movement smaller than this is noise, not a result. */
const MATERIAL = 0.05;

function campaign(ctx: MeasureContext, subject: string | null): CampaignAgg | null {
  if (!subject) return null;
  return ctx.camps.find((c) => c.campaign_name === subject) ?? null;
}

function sessionsWhere(ga: GaDaily[], re: RegExp): number {
  return ga.filter((r) => re.test(r.channel_group)).reduce((s, r) => s + r.sessions, 0);
}

function pageRows(ga: GaDaily[], path: string | null): GaDaily[] {
  if (!path) return [];
  return ga.filter((r) => r.landing_page === path);
}

/** Current value of a check, or null when the subject is no longer present. */
export function measureCheck(check: IntelCheck, ctx: MeasureContext): number | null {
  switch (check.kind) {
    case "campaign_roas": {
      const c = campaign(ctx, check.subject);
      return c ? c.roas : null;
    }
    case "campaign_spend": {
      const c = campaign(ctx, check.subject);
      // A paused campaign is $0 spend, which is a real result, not a gap.
      return c ? c.spend : 0;
    }
    case "campaign_lost_is_budget": {
      const c = campaign(ctx, check.subject);
      return c?.lost_is_budget ?? null;
    }
    case "campaign_frequency": {
      const c = campaign(ctx, check.subject);
      if (!c) return null;
      return c.frequency_peak ?? c.frequency ?? null;
    }
    case "blended_roas":
      return ctx.blended.spend > 0 ? ctx.blended.roas : null;
    case "platform_roas": {
      const k = check.subject === "meta" ? ctx.meta : ctx.google;
      return k.spend > 0 ? k.roas : null;
    }
    case "paid_social_sessions":
      return sessionsWhere(ctx.ga, /paid social/i);
    case "unassigned_share": {
      const total = ctx.ga.reduce((s, r) => s + r.sessions, 0);
      if (!total) return null;
      return round4(sessionsWhere(ctx.ga, /unassigned/i) / total);
    }
    case "mobile_cvr": {
      let sessions = 0, ke = 0;
      for (const r of ctx.ga) {
        if (r.device !== "mobile") continue;
        sessions += r.sessions;
        ke += r.key_events;
      }
      return sessions ? round4(ke / sessions) : null;
    }
    case "page_bounce": {
      const rows = pageRows(ctx.ga, check.subject);
      let num = 0, den = 0;
      for (const r of rows) {
        if (r.bounce_rate == null) continue;
        num += r.bounce_rate * r.sessions;
        den += r.sessions;
      }
      return den ? round4(num / den) : null;
    }
    case "page_key_events": {
      const rows = pageRows(ctx.ga, check.subject);
      return rows.length ? rows.reduce((s, r) => s + r.key_events, 0) : null;
    }
    case "query_ctr": {
      const q = ctx.queries.find((r) => r.kind === "query" && r.query === check.subject);
      return q?.ctr ?? null;
    }
    case "url_ctr": {
      const p = ctx.queries.find((r) => r.kind === "page" && r.query.includes(check.subject ?? "\u0000"));
      return p?.ctr ?? null;
    }
    default:
      return null;
  }
}

function fmtValue(v: number | null, unit: IntelCheck["unit"]): string {
  if (v == null) return "—";
  switch (unit) {
    case "roas": return `${v.toFixed(2)}x`;
    case "usd": return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case "pct": return `${v.toFixed(1)}%`;
    case "ratio": return `${(v * 100).toFixed(1)}%`;
    default: return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
}

function passesTarget(value: number, check: IntelCheck): boolean {
  if (check.target == null) return false;
  return check.direction === "up" ? value >= check.target : value <= check.target;
}

/**
 * Grade an applied card. `sameWindow` means the newest data is still the window
 * the change was made in, so there is nothing to compare yet.
 */
export function gradeOutcome(opts: {
  check: IntelCheck;
  baseline: number | null;
  baselineAsOf: string | null;
  currentAsOf: string;
  ctx: MeasureContext;
}): IntelOutcome {
  const { check, baseline, baselineAsOf, currentAsOf, ctx } = opts;
  const current = measureCheck(check, ctx);
  const base = { 
    baseline, baseline_as_of: baselineAsOf, current,
    target: check.target, direction: check.direction, unit: check.unit, label: check.label,
  };

  if (!baselineAsOf || baselineAsOf >= currentAsOf) {
    return {
      ...base,
      verdict: "too_early" as OutcomeVerdict,
      summary: `Applied in the current window — ${check.label} reads ${fmtValue(current, check.unit)}. Upload next week's export to grade it.`,
    };
  }
  if (current == null || baseline == null) {
    const gone = check.kind.startsWith("campaign") && current == null;
    return {
      ...base,
      verdict: "unmeasurable" as OutcomeVerdict,
      summary: gone
        ? `${check.subject} no longer appears in the window — treat as paused.`
        : `${check.label} cannot be measured in the current window.`,
    };
  }

  const improved = check.direction === "up" ? current - baseline : baseline - current;
  const denom = Math.abs(baseline) > 0 ? Math.abs(baseline) : 1;
  const rel = improved / denom;
  const hitTarget = passesTarget(current, check);
  const move = `${check.label} ${fmtValue(baseline, check.unit)} → ${fmtValue(current, check.unit)}`;

  const moved = Math.abs(rel) >= MATERIAL;
  let verdict: OutcomeVerdict;
  if (hitTarget || rel >= MATERIAL) verdict = "worked";
  else if (rel <= -MATERIAL) verdict = "worse";
  else verdict = "no_change";

  const targetNote = check.target != null
    ? ` Target ${check.direction === "up" ? "≥" : "≤"} ${fmtValue(check.target, check.unit)}${hitTarget ? " — met" : " — not met"}.`
    : "";
  let summary: string;
  if (verdict === "worse") {
    summary = `Went the wrong way: ${move}.${targetNote} Consider reverting.`;
  } else if (verdict === "worked" && !moved) {
    // A "hold" card passes by not moving — say that rather than claiming a win.
    summary = `Holding at ${fmtValue(current, check.unit)} — ${check.label} is where it needs to be.${targetNote}`;
  } else if (verdict === "worked" && !hitTarget) {
    summary = `Improving: ${move}, still short of target.${targetNote}`;
  } else if (verdict === "worked") {
    summary = `Worked: ${move}.${targetNote}`;
  } else {
    summary = `No material change: ${move}.${targetNote}`;
  }
  return { ...base, verdict, summary };
}
