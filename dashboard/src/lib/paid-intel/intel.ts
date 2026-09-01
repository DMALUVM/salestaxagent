import { deriveRoas, round2, round4 } from "./csv";
import {
  aggregateCampaigns, aggregateProducts, buildFreshness, dailySeries, filterCampaigns,
  gaInRange, kpisOf, maxPaidDate, priorWindow, productWeightsFromGa, rangeStart,
  snapshotQueries, type SourceStats,
} from "./window";
import { buildCardPrompt, buildGrok, type SitePromptContext } from "./grok";
import { gradeOutcome, measureCheck, type MeasureContext } from "./outcome";
import { buildWebInsights } from "./web-insights";
import type {
  CampaignAgg, CampaignDaily, DecisionStatus, GaDaily, IntelBrief, IntelBundle,
  IntelCard, IntelCheck, IntelDecision, IntelFilter, IntelOwner, IntelRangeDays,
  PlatformKpis, SearchQueryDaily, WinLoseRow,
} from "./types";

const PAID_GA = /^(paid search|paid social|cross-network|display|paid other)$/i;

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function roas(n: number): string {
  return `${n.toFixed(2)}x`;
}

function card(
  partial: Omit<
    IntelCard,
    "severity" | "owner" | "prompt" | "status" | "decided_at" | "note" | "outcome" | "check" | "check_value"
  > & {
    severity?: IntelCard["severity"];
    owner?: IntelOwner;
    check?: IntelCheck | null;
  },
): IntelCard {
  const stake = partial.stake;
  const severity = partial.severity ?? (stake >= 200 ? "critical" : stake >= 50 ? "warn" : "info");
  return {
    owner: "ads",
    check: null,
    ...partial,
    severity,
    prompt: "",
    status: "open",
    decided_at: null,
    note: null,
    check_value: null,
    outcome: null,
  };
}

/** A mix cut should at least beat where the blend already was. */
function blendedTarget(g: PlatformKpis, m: PlatformKpis): number {
  const spend = g.spend + m.spend;
  const value = g.conv_value + m.conv_value;
  return spend > 0 ? (value / spend) * 1.1 : 1;
}

function check(
  kind: IntelCheck["kind"],
  subject: string | null,
  direction: IntelCheck["direction"],
  target: number | null,
  unit: IntelCheck["unit"],
  label: string,
): IntelCheck {
  return { kind, subject, direction, target, unit, label };
}

function nonBrandGoogle(camps: CampaignAgg[]): CampaignAgg[] {
  return camps.filter((c) => c.platform === "google" && !c.is_brand);
}

function bestNonBrandTarget(camps: CampaignAgg[]): CampaignAgg | null {
  const pool = nonBrandGoogle(camps).filter((c) => c.spend >= 1 && c.roas >= 1.2);
  return pool.sort((a, b) => b.roas - a.roas || b.spend - a.spend)[0] ?? null;
}

function scaleTargetName(camps: CampaignAgg[]): string {
  const t = bestNonBrandTarget(camps);
  if (t) return t.campaign_name;
  const pmax = camps.find((c) => c.platform === "google" && c.campaign_type === "PMax" && !c.is_brand);
  if (pmax && pmax.roas >= 1.0) return pmax.campaign_name;
  return "";
}

function worstNamed(camps: CampaignAgg[], platform: CampaignAgg["platform"]): CampaignAgg | null {
  return camps
    .filter((c) => c.platform === platform && c.spend >= 1 && !c.is_brand)
    .sort((a, b) => a.roas - b.roas || b.spend - a.spend)[0] ?? null;
}

function detectMixCut(last: CampaignDaily[], camps: CampaignAgg[]): IntelCard | null {
  const g = kpisOf(last, "google");
  const m = kpisOf(last, "meta");
  if (g.spend < 40 || m.spend < 40) return null;
  const loser = g.roas <= m.roas ? g : m;
  const winner = loser === g ? m : g;
  if (winner.roas - loser.roas < 0.35) return null;
  const stake = round2(loser.spend * Math.min(0.4, Math.max(0.15, 1 - loser.roas / Math.max(winner.roas, 0.01))));
  if (stake < 20) return null;
  const target = scaleTargetName(camps);
  const cutFrom = loser.platform === "meta"
    ? (worstNamed(camps, "meta")?.campaign_name ?? "Meta prospecting")
    : (worstNamed(camps, "google")?.campaign_name ?? "Google non-brand");
  const redeploy = target
    ? `Move at most half of that to ${target}. Pocket the rest.`
    : "Pocket the cut — no non-brand campaign is strong enough to absorb it.";
  return card({
    id: "mix-cut",
    title: `${loser.platform === "google" ? "Google" : "Meta"} is the expensive half of the mix`,
    body: `Last 7 days: Google ${money(g.spend)} at ${roas(g.roas)} vs Meta ${money(m.spend)} at ${roas(m.roas)}. Cut the loser. Do not park the dollars on Brand Search or on a sub-1x Search campaign.`,
    doThis: `7-day test: pull ${money(stake)} off ${cutFrom}. ${redeploy} Leave Brand Search untouched.`,
    ifItWorks: `Blended ads ROAS rises toward ${roas(winner.roas)} without a Brand Search spend spike.`,
    evidence: `Google ROAS ${roas(g.roas)} on ${money(g.spend)}; Meta ROAS ${roas(m.roas)} on ${money(m.spend)}.`,
    stake,
    metric: `${loser.platform} ${roas(loser.roas)} — cut`,
    action: "shift",
    check: check("blended_roas", null, "up", round4(Math.max(winner.roas * 0.9, blendedTarget(g, m))), "roas", "Blended ads ROAS"),
  });
}

function detectReallocate(camps: CampaignAgg[]): IntelCard | null {
  const byPlat = new Map<string, CampaignAgg[]>();
  for (const c of camps) {
    if (c.spend < 1) continue;
    const list = byPlat.get(c.platform) ?? [];
    list.push(c);
    byPlat.set(c.platform, list);
  }
  let best: IntelCard | null = null;
  for (const [platform, list] of byPlat) {
    const losers = list.filter((c) => c.roas < 0.8 && c.spend >= 25 && !(platform === "google" && c.is_brand));
    const winners = list.filter((c) => c.roas >= 1.6 && c.spend >= 1 && !(platform === "google" && c.is_brand));
    if (!losers.length || !winners.length) continue;
    const lose = losers.sort((a, b) => a.roas - b.roas || b.spend - a.spend)[0];
    const win = winners.sort((a, b) => b.roas - a.roas)[0];
    const stake = round2(lose.spend * 0.35);
    const cand = card({
      id: `realloc-${platform}`,
      title: `Reallocate inside ${platform === "google" ? "Google" : "Meta"} — not onto brand`,
      body: `${lose.campaign_name} spent ${money(lose.spend)} at ${roas(lose.roas)}. ${win.campaign_name} is ${roas(win.roas)}. Move the waste to the winner. Brand Search is a hold, not a parking lot.`,
      doThis: `7-day test: cut ${lose.campaign_name} by ~35% (${money(stake)}) and add that to ${win.campaign_name}.`,
      ifItWorks: `${lose.campaign_name} ROAS rises or its spend is gone; ${win.campaign_name} holds ≥ ${roas(win.roas)}.`,
      evidence: `Loser ${lose.campaign_name} ${money(lose.spend)} / ${roas(lose.roas)}; winner ${win.campaign_name} ${money(win.spend)} / ${roas(win.roas)}.`,
      stake,
      metric: `${roas(lose.roas)} — shift`,
      action: "shift",
    });
    if (!best || cand.stake > best.stake) best = cand;
  }
  return best;
}

function detectDeadSpend(last: CampaignDaily[], camps: CampaignAgg[], asOf: string): IntelCard | null {
  const live = new Set(
    last.filter((r) => r.spend > 0 && r.date >= shiftBack(asOf, 2)).map((r) => `${r.platform}|${r.campaign_name}`),
  );
  const dead = camps.filter((c) =>
    c.spend >= 20 && c.conversions < 0.5 && c.conv_value < 1 && live.has(`${c.platform}|${c.campaign_name}`)
    && !(c.platform === "google" && c.is_brand && c.spend < 40));
  if (!dead.length) return null;
  const top = dead.sort((a, b) => b.spend - a.spend)[0];
  return card({
    id: "dead-spend",
    title: `Dead spend is still live: ${top.campaign_name}`,
    body: `${dead.length} campaign${dead.length > 1 ? "s" : ""} spent in the last 7 days with ~0 conversions and still burned dollars in the last 3 days.`,
    doThis: `7-day test: pause ${top.campaign_name} (and any sibling with $0 conversions). Do not send that budget to Brand Search.`,
    ifItWorks: `Account waste drops by ~${money(top.spend)} and blended ROAS ticks up.`,
    evidence: dead.slice(0, 4).map((c) => `${c.campaign_name} ${money(c.spend)} / ${c.conversions} conv`).join("; "),
    stake: round2(dead.reduce((s, c) => s + c.spend, 0)),
    metric: `${money(top.spend)} @ 0 conv — kill`,
    action: "kill",
    check: check("campaign_spend", top.campaign_name, "down", round2(top.spend * 0.5), "usd", `${top.campaign_name} spend`),
  });
}

function shiftBack(asOf: string, days: number): string {
  const d = new Date(`${asOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function detectProductMix(
  products: ReturnType<typeof aggregateProducts>,
  camps: CampaignAgg[],
  weights?: { basis: string; sample: number },
): IntelCard | null {
  const real = products.filter((p) => p.product !== "other" && p.spend >= 20);
  if (real.length < 2) return null;
  const sorted = [...real].sort((a, b) => b.roas - a.roas);
  const win = sorted[0];
  const lose = sorted[sorted.length - 1];
  if (win.roas - lose.roas < 0.4 || lose.spend < 25) return null;
  const stake = round2(lose.spend * 0.3);
  const target = camps.find((c) => c.product === win.product && !c.is_brand && c.spend >= 1);
  const estimated = real.some((p) => p.estimated);
  const note = estimated
    ? ` PMax and Brand Search carry no product in their names, so their share is allocated by where paid GA4 traffic landed (${weights?.basis ?? "landing mix"}); the ads conversion-value total is unchanged.`
    : "";
  return card({
    id: "product-mix",
    title: `${win.product} is carrying ${lose.product}`,
    body: `${win.product} ROAS ${roas(win.roas)} vs ${lose.product} ${roas(lose.roas)} on ${money(lose.spend)}. Shift creative and budget toward ${win.product}.${note}`,
    doThis: `7-day test: cut ${lose.product} prospecting ~30% (${money(stake)}) and put it on ${target?.campaign_name ?? win.product + " non-brand"}.`,
    ifItWorks: `${win.product} spend share rises and blended product ROAS moves toward ${roas(win.roas)}.`,
    evidence: `${real.map((p) => `${p.product} ${money(p.spend)} ${roas(p.roas)}${p.estimated ? " (est.)" : ""}`).join("; ")}`,
    stake,
    metric: `${lose.product} ${roas(lose.roas)} — shift`,
    action: "shift",
    check: check("blended_roas", null, "up", null, "roas", "Blended ads ROAS"),
  });
}

function detectCollapse(last: CampaignDaily[], prior: CampaignDaily[]): IntelCard | null {
  const a = kpisOf(last, "blended");
  const b = kpisOf(prior, "blended");
  if (b.spend < 40 || a.spend < 20) return null;
  const revDrop = b.conv_value > 0 ? (b.conv_value - a.conv_value) / b.conv_value : 0;
  const roasDrop = b.roas > 0 ? (b.roas - a.roas) / b.roas : 0;
  const spendFlat = Math.abs(a.spend - b.spend) / Math.max(b.spend, 1) <= 0.15;
  if (revDrop < 0.18 && roasDrop < 0.2) return null;
  const stake = round2(Math.max(0, b.conv_value - a.conv_value));
  const worst = [...aggregateCampaigns(last)]
    .filter((c) => !c.is_brand && c.spend >= 20)
    .sort((x, y) => x.roas - y.roas)[0];
  return card({
    id: "wow-collapse",
    title: spendFlat
      ? "Spend held. Conversion value did not."
      : "Last 7 days collapsed vs the prior 7",
    body: `Conv. value ${money(a.conv_value)} vs ${money(b.conv_value)} prior (${Math.round(revDrop * 100)}% drop). ROAS ${roas(a.roas)} vs ${roas(b.roas)}. ${spendFlat ? "This is an efficiency problem, not a budget problem." : ""}`.trim(),
    doThis: `7-day test: freeze new tests. Hold Brand Search. Cut ${worst?.campaign_name ?? "the worst non-brand loser"} ~30%. Keep PMax live at the current daily. Do not raise anything to "make up" the week.`,
    ifItWorks: "This week's conv. value recovers at least halfway to the prior week on the same or less spend.",
    evidence: `Last7 spend ${money(a.spend)} ROAS ${roas(a.roas)}; prior7 spend ${money(b.spend)} ROAS ${roas(b.roas)}.`,
    stake: Math.max(stake, 40),
    metric: `ROAS ${roas(a.roas)} vs ${roas(b.roas)} — diagnose`,
    action: "fix",
    check: check("blended_roas", null, "up", round4(b.roas * 0.75), "roas", "Blended ads ROAS"),
    severity: "critical",
  });
}

function detectBrandSplit(camps: CampaignAgg[]): IntelCard | null {
  const brand = camps.filter((c) => c.platform === "google" && c.is_brand);
  const non = nonBrandGoogle(camps);
  const bSpend = brand.reduce((s, c) => s + c.spend, 0);
  const bConv = brand.reduce((s, c) => s + c.conv_value, 0);
  const nSpend = non.reduce((s, c) => s + c.spend, 0);
  const nConv = non.reduce((s, c) => s + c.conv_value, 0);
  if (bSpend < 15 || nSpend < 20) return null;
  const bRoas = deriveRoas(bSpend, bConv);
  const nRoas = deriveRoas(nSpend, nConv);
  const target = scaleTargetName(camps);
  if (bRoas >= 1.8) {
    const scale = target && nRoas >= 1.2
      ? `Add ~15% budget to ${target}.`
      : `Do not add budget to non-brand until a campaign clears 1.2x. ${target ? `Closest is ${target}.` : ""} Keep Brand Search spend flat.`;
    return card({
      id: "brand-split",
      title: "Hold Brand Search — it is harvest, not growth",
      body: `Brand is ${roas(bRoas)} on ${money(bSpend)}. Non-brand is ${roas(nRoas)} on ${money(nSpend)}. Raising Brand Search steals cheap returning demand and will not fix the week.`,
      doThis: `7-day test: do not raise Brand Search. Cap it at last week's spend. ${scale}`,
      ifItWorks: "Brand spend stays flat; incremental conversions come from a non-brand campaign at ≥ 1.2x, or spend simply falls.",
      evidence: `Brand ${money(bSpend)} ${roas(bRoas)}; non-brand ${money(nSpend)} ${roas(nRoas)}.`,
      stake: round2(Math.max(nSpend * 0.15, bSpend * 0.2)),
      metric: `brand ${roas(bRoas)} keep · do not scale`,
      action: "keep",
    check: check("campaign_spend", brand.sort((x, y) => y.spend - x.spend)[0]?.campaign_name ?? null, "down", round2(bSpend * 1.1), "usd", "Brand Search spend"),
    });
  }
  if (bSpend > nSpend && bRoas < 1.4) {
    return card({
      id: "brand-split",
      title: "Brand Search is eating the Google budget",
      body: `Brand ${money(bSpend)} at ${roas(bRoas)} vs non-brand ${money(nSpend)}. Cap brand; do not add more.`,
      doThis: `7-day test: cap Brand Search at last week's spend. Move any leftover to ${target}.`,
      ifItWorks: "Brand spend share falls; incremental conversions come from non-brand.",
      evidence: `Brand share ${Math.round(bSpend / (bSpend + nSpend) * 100)}% of Google.`,
      stake: round2(bSpend * 0.2),
      metric: `brand share high — cap`,
      action: "shift",
    check: check("campaign_spend", brand.sort((x, y) => y.spend - x.spend)[0]?.campaign_name ?? null, "down", round2(bSpend), "usd", "Brand Search spend"),
    });
  }
  return null;
}

/**
 * Fatigue lives at ad-set level. A campaign-weighted average of 2.0 can hide
 * one ad set at 4.0, so prefer the peak when an ad-set export supplied it and
 * hold the campaign-only threshold lower, labelled for what it is.
 */
function detectFrequency(camps: CampaignAgg[]): IntelCard | null {
  const meta = camps.filter((c) => c.platform === "meta" && c.spend >= 15);
  const hasPeak = meta.some((c) => c.frequency_peak != null);
  const freqOf = (c: CampaignAgg) => (hasPeak ? c.frequency_peak ?? c.frequency ?? 0 : c.frequency ?? 0);
  const threshold = hasPeak ? 2.4 : 1.9;
  const hot = meta.filter((c) => freqOf(c) > threshold);
  if (!hot.length) return null;
  const top = hot.sort((a, b) => freqOf(b) - freqOf(a))[0];
  const level = hasPeak ? "worst ad set" : "campaign-weighted";
  return card({
    id: "meta-freq",
    title: `Meta frequency ${freqOf(top).toFixed(2)} on ${top.campaign_name}`,
    body: hasPeak
      ? `The worst ad set inside ${top.campaign_name} is at ${freqOf(top).toFixed(2)}. That is fatigue, not reach. Refresh or tighten before adding budget.`
      : `Campaign-weighted frequency is ${freqOf(top).toFixed(2)} and climbing. This export is campaign level, so a single burnt ad set is averaged away — the real number is higher. Export ad sets to see it.`,
    doThis: hasPeak
      ? `7-day test: new creative on the worst ad set in ${top.campaign_name}, or cut the audience overlap. Do not raise spend until it is ≤ 2.2.`
      : `7-day test: pull the Ads Manager export at ad-set level and upload it, then refresh creative on whichever ad set is above 2.4. Do not raise ${top.campaign_name} spend meanwhile.`,
    ifItWorks: "Frequency falls toward 2.0 and CPA stops sliding on the same spend.",
    evidence: hot.map((c) => `${c.campaign_name} ${level} freq ${freqOf(c).toFixed(2)} on ${money(c.spend)}`).join("; "),
    stake: round2(hot.reduce((s, c) => s + c.spend, 0) * 0.25),
    metric: `freq ${freqOf(top).toFixed(2)} (${level}) — refresh`,
    action: "fix",
    check: check("campaign_frequency", top.campaign_name, "down", 2.2, "count", `${top.campaign_name} frequency`),
  });
}

function detectProspectRetarget(camps: CampaignAgg[]): IntelCard | null {
  const meta = camps.filter((c) => c.platform === "meta" && c.spend >= 10);
  const p = meta.filter((c) => c.audience === "prospect");
  const r = meta.filter((c) => c.audience === "retarget");
  if (!p.length || !r.length) return null;
  const pK = { spend: p.reduce((s, c) => s + c.spend, 0), conv: p.reduce((s, c) => s + c.conv_value, 0) };
  const rK = { spend: r.reduce((s, c) => s + c.spend, 0), conv: r.reduce((s, c) => s + c.conv_value, 0) };
  const pR = deriveRoas(pK.spend, pK.conv);
  const rR = deriveRoas(rK.spend, rK.conv);
  if (Math.abs(pR - rR) < 0.3) return null;
  const loserIsRetarget = rR < pR;
  const stake = round2((loserIsRetarget ? rK.spend : pK.spend) * 0.3);
  return card({
    id: "meta-funnel",
    title: loserIsRetarget ? "Retargeting is weaker than prospecting" : "Prospecting is weaker than retargeting",
    body: `Prospect ${money(pK.spend)} at ${roas(pR)} vs retarget ${money(rK.spend)} at ${roas(rR)}.`,
    doThis: loserIsRetarget
      ? "7-day test: cut retarget ~30% (frequency is usually the leak) and keep prospecting live."
      : "7-day test: cut the worst prospecting ad set ~30%; hold retarget if frequency ≤ 2.4.",
    ifItWorks: "The cheaper half of the Meta funnel keeps ROAS; wasted half shrinks.",
    evidence: `Prospect ${roas(pR)}; retarget ${roas(rR)}.`,
    stake,
    metric: `${loserIsRetarget ? "retarget" : "prospect"} ${roas(loserIsRetarget ? rR : pR)} — cut`,
    action: "shift",
    check: check("platform_roas", "meta", "up", round4(Math.max(pR, rR) * 0.9), "roas", "Meta ROAS"),
  });
}

function detectLostIsTrap(camps: CampaignAgg[]): IntelCard | null {
  const hits = camps.filter((c) =>
    c.platform === "google" && !c.is_brand && (c.lost_is_budget ?? 0) > 12 && c.roas < 1.2 && c.spend >= 25);
  if (!hits.length) return null;
  const top = hits.sort((a, b) => a.roas - b.roas || b.spend - a.spend)[0];
  return card({
    id: "lost-is-trap",
    title: `Do not raise ${top.campaign_name} — lost IS is not a budget signal`,
    body: `Lost IS (budget) ${(top.lost_is_budget ?? 0).toFixed(0)}% looks like “constrained demand.” It is not. ROAS is ${roas(top.roas)} on ${money(top.spend)}. Raising daily budget here buys more of a losing query mix.`,
    doThis: `7-day test: cut ${top.campaign_name} ~25% (${money(round2(top.spend * 0.25))}). Tighten the asset group / search theme. Do not move that money to Brand Search.`,
    ifItWorks: `ROAS on ${top.campaign_name} rises above 1.0x, or the spend is gone and blended Google ROAS ticks up.`,
    evidence: hits.map((c) => `${c.campaign_name} lost-IS ${(c.lost_is_budget ?? 0).toFixed(0)}% ROAS ${roas(c.roas)} ${money(c.spend)}`).join("; "),
    stake: round2(top.spend * 0.25),
    metric: `lost IS ${(top.lost_is_budget ?? 0).toFixed(0)}% · ROAS ${roas(top.roas)} — cut`,
    action: "kill",
    check: check("campaign_roas", top.campaign_name, "up", 1.0, "roas", `${top.campaign_name} ROAS`),
    severity: "critical",
  });
}

function detectWorstLive(camps: CampaignAgg[]): IntelCard[] {
  const out: IntelCard[] = [];
  for (const platform of ["google", "meta"] as const) {
    const worst = camps
      .filter((c) => c.platform === platform && !c.is_brand && c.spend >= 40 && c.roas < 0.85)
      .sort((a, b) => a.roas - b.roas || b.spend - a.spend)[0];
    if (!worst) continue;
    if (platform === "google" && (worst.lost_is_budget ?? 0) > 12) continue; // lost-is-trap owns it
    const cut = round2(worst.spend * 0.3);
    out.push(card({
      id: `worst-${platform}`,
      title: `Cut ${worst.campaign_name} first`,
      body: `${worst.campaign_name} spent ${money(worst.spend)} at ${roas(worst.roas)} with ${worst.conversions} conversions. That is the weakest live ${platform === "google" ? "Google" : "Meta"} campaign. Do not “refresh and scale.”`,
      doThis: `7-day test: cut daily budget ~30% (${money(cut)}) on ${worst.campaign_name}. Keep the better sibling live. Do not send the leftover to Brand Search.`,
      ifItWorks: `${worst.campaign_name} ROAS ≥ 1.0x on the remaining spend, or it is paused and account ROAS rises.`,
      evidence: `${worst.campaign_name} ${money(worst.spend)} / ${roas(worst.roas)} / ${worst.conversions} conv · ${worst.product} · ${worst.audience !== "unknown" ? worst.audience : worst.campaign_type}.`,
      stake: cut,
      metric: `${roas(worst.roas)} — cut 30%`,
      action: "kill",
    }));
  }
  return out;
}

function detectPmaxHold(camps: CampaignAgg[]): IntelCard | null {
  const pmax = camps.filter((c) => c.platform === "google" && c.campaign_type === "PMax" && !c.is_brand);
  const spend = pmax.reduce((s, c) => s + c.spend, 0);
  const conv = pmax.reduce((s, c) => s + c.conv_value, 0);
  if (spend < 80) return null;
  const r = deriveRoas(spend, conv);
  if (r < 0.8 || r > 1.8) return null;
  const name = pmax.sort((a, b) => b.spend - a.spend)[0]?.campaign_name ?? "PMax";
  return card({
    id: "pmax-hold",
    title: `${name} is the only non-brand engine near 1x — hold`,
    body: `PMax is ${roas(r)} on ${money(spend)}. That is not a scale signal and not a kill signal. Daily results are lumpy. Do not chase a $0 day by raising Brand Search or AI MAX.`,
    doThis: `7-day test: hold ${name} at the current daily. No new asset groups. No Brand Search dump. Review one week of conv. value, not one day.`,
    ifItWorks: "PMax weekly ROAS stays ≥ 1.0x and Brand Search spend does not rise.",
    evidence: pmax.map((c) => `${c.campaign_name} ${money(c.spend)} ${roas(c.roas)}`).join("; "),
    stake: round2(spend * 0.1),
    metric: `PMax ${roas(r)} — hold`,
    action: "keep",
    check: check("campaign_roas", name, "up", 1.0, "roas", `${name} ROAS`),
  });
}

function detectLostIs(camps: CampaignAgg[]): IntelCard | null {
  const hits = camps.filter((c) =>
    c.platform === "google" && !c.is_brand && (c.lost_is_budget ?? 0) > 12 && c.roas > 1.6 && c.spend >= 20);
  if (!hits.length) return null;
  const top = hits.sort((a, b) => (b.lost_is_budget ?? 0) - (a.lost_is_budget ?? 0))[0];
  const stake = round2(top.spend * ((top.lost_is_budget ?? 0) / 100));
  return card({
    id: "lost-is-budget",
    title: `${top.campaign_name} is losing IS to budget`,
    body: `Lost IS (budget) ${ (top.lost_is_budget ?? 0).toFixed(1)}% while ROAS is ${roas(top.roas)}. This is constrained demand, not a creative problem.`,
    doThis: `7-day test: raise daily budget ~15–20% on ${top.campaign_name}. Do not touch Brand Search.`,
    ifItWorks: "Lost IS (budget) falls under 12% and conversions rise without ROAS crashing below 1.4.",
    evidence: hits.map((c) => `${c.campaign_name} lost-IS-budget ${(c.lost_is_budget ?? 0).toFixed(1)}% ROAS ${roas(c.roas)}`).join("; "),
    stake: Math.max(stake, 30),
    metric: `lost IS ${ (top.lost_is_budget ?? 0).toFixed(0)}% · ROAS ${roas(top.roas)} — raise`,
    action: "keep",
    check: check("campaign_lost_is_budget", top.campaign_name, "down", 12, "pct", `${top.campaign_name} lost IS (budget)`),
  });
}

function detectPmaxVsSearch(camps: CampaignAgg[]): IntelCard | null {
  const pmax = camps.filter((c) => c.platform === "google" && c.campaign_type === "PMax" && !c.is_brand);
  const search = camps.filter((c) => c.platform === "google" && c.campaign_type === "Search" && !c.is_brand);
  const pS = pmax.reduce((s, c) => s + c.spend, 0);
  const pV = pmax.reduce((s, c) => s + c.conv_value, 0);
  const sS = search.reduce((s, c) => s + c.spend, 0);
  const sV = search.reduce((s, c) => s + c.conv_value, 0);
  if (pS < 30 || sS < 15) return null;
  const pR = deriveRoas(pS, pV);
  const sR = deriveRoas(sS, sV);
  if (Math.abs(pR - sR) < 0.3) return null;
  const pmaxWorse = pR < sR;
  const stake = round2((pmaxWorse ? pS : sS) * 0.2);
  return card({
    id: "pmax-vs-search",
    title: pmaxWorse ? "Non-brand Search is beating PMax" : "PMax is beating non-brand Search",
    body: `PMax ${money(pS)} at ${roas(pR)} vs non-brand Search ${money(sS)} at ${roas(sR)}. GA4 Cross-network is the PMax analogue — do not read it as Brand Search.`,
    doThis: pmaxWorse
      ? `7-day test: trim PMax ~20% and add that to ${search.sort((a, b) => b.roas - a.roas)[0]?.campaign_name ?? "non-brand Search"}.`
      : `7-day test: hold PMax; do not dump leftover Search budget onto Brand Search.`,
    ifItWorks: "The cheaper engine keeps ROAS; the expensive engine shrinks.",
    evidence: `PMax ${roas(pR)}; non-brand Search ${roas(sR)}.`,
    stake,
    metric: `${pmaxWorse ? "PMax" : "Search"} ${roas(pmaxWorse ? pR : sR)} — shift`,
    action: "shift",
    check: check("platform_roas", "google", "up", round4(Math.max(pR, sR) * 0.9), "roas", "Google ROAS"),
  });
}

function detectShoppingVsPmax(camps: CampaignAgg[]): IntelCard | null {
  const shop = camps.filter((c) => c.platform === "google" && c.campaign_type === "Shopping");
  const pmax = camps.filter((c) => c.platform === "google" && c.campaign_type === "PMax" && !c.is_brand);
  const sS = shop.reduce((s, c) => s + c.spend, 0);
  const sV = shop.reduce((s, c) => s + c.conv_value, 0);
  const pS = pmax.reduce((s, c) => s + c.spend, 0);
  const pV = pmax.reduce((s, c) => s + c.conv_value, 0);
  if (sS < 20 || pS < 20) return null;
  const sR = deriveRoas(sS, sV);
  const pR = deriveRoas(pS, pV);
  if (Math.abs(sR - pR) < 0.3) return null;
  const shopWorse = sR < pR;
  return card({
    id: "shopping-vs-pmax",
    title: shopWorse ? "Shopping is losing to PMax" : "Shopping is beating PMax",
    body: `Shopping ${money(sS)} at ${roas(sR)} vs PMax ${money(pS)} at ${roas(pR)}.`,
    doThis: `7-day test: move ~20% from the weaker engine to the stronger. Never onto Brand Search.`,
    ifItWorks: "The stronger engine's spend share rises; blended Google ROAS holds or rises.",
    evidence: `Shopping ${roas(sR)}; PMax ${roas(pR)}.`,
    stake: round2((shopWorse ? sS : pS) * 0.2),
    metric: `${shopWorse ? "Shopping" : "PMax"} weaker — shift`,
    action: "shift",
    check: check("platform_roas", "google", "up", round4(Math.max(sR, pR) * 0.9), "roas", "Google ROAS"),
  });
}

function detectGscTitleTrap(queries: SearchQueryDaily[]): IntelCard | null {
  const hits = queries.filter((q) =>
    q.kind === "query" && q.date === "" && (q.position ?? 99) >= 4 && (q.position ?? 99) <= 8
    && q.impressions >= 400 && (q.ctr ?? 100) < 1);
  if (!hits.length) return null;
  const top = [...hits].sort((a, b) => b.impressions - a.impressions)[0];
  return card({
    id: "gsc-title-trap",
    owner: "site",
    title: `"${top.query}" is already on page one — the title is the leak`,
    body: `Snapshot rank ${top.position?.toFixed(1)} with ${fmtInt(top.impressions)} impressions and CTR ${top.ctr?.toFixed(2)}%. This is not a ranking problem. Do not invent a Δ position from Queries.csv.`,
    doThis: `7-day test: rewrite title + meta + first 120 characters to match "${top.query}" exactly (include the product noun). Point an above-the-fold CTA at the matching PDP. Organic only — no ad changes.`,
    ifItWorks: `CTR on "${top.query}" doubles on the next Queries.csv snapshot.`,
    evidence: hits.slice(0, 4).map((q) => `"${q.query}" pos ${q.position?.toFixed(1)} · ${q.impressions} impr · CTR ${q.ctr?.toFixed(2)}%`).join("; "),
    stake: round2(Math.max(top.impressions * 0.02, 40)),
    metric: `CTR ${top.ctr?.toFixed(2)}% at pos ${top.position?.toFixed(1)} — rewrite`,
    action: "fix",
    check: check("query_ctr", top.query, "up", round4((top.ctr ?? 0) * 2 || 1), "pct", `CTR on "${top.query}"`),
  });
}

function detectGscClimb(queries: SearchQueryDaily[]): IntelCard | null {
  const hits = queries.filter((q) =>
    q.kind === "query" && q.date === "" && (q.position ?? 0) >= 8 && (q.position ?? 0) <= 15
    && q.impressions >= 200 && (q.ctr ?? 0) >= 2);
  if (!hits.length) return null;
  const top = [...hits].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)[0];
  return card({
    id: "gsc-climb",
    owner: "site",
    title: `"${top.query}" already earns the click — help it climb`,
    body: `CTR ${top.ctr?.toFixed(1)}% at position ${top.position?.toFixed(1)} on ${fmtInt(top.impressions)} impressions. The snippet works. Rank is the constraint. Snapshot only — no invented Δ.`,
    doThis: `7-day test: add two internal links with the exact anchor "${top.query}" from the homepage and the closest blog. Strengthen the matching PDP H1. Organic only — no ad changes.`,
    ifItWorks: "Clicks on that query rise on the next snapshot. Position may or may not move.",
    evidence: hits.slice(0, 3).map((q) => `"${q.query}" pos ${q.position?.toFixed(1)} · CTR ${q.ctr?.toFixed(1)}% · ${q.clicks} clicks`).join("; "),
    stake: round2(top.clicks * 12),
    metric: `pos ${top.position?.toFixed(1)} · CTR ${top.ctr?.toFixed(1)}% — links`,
    action: "fix",
    check: check("query_ctr", top.query, "up", null, "pct", `CTR on "${top.query}"`),
    severity: "info",
  });
}

function detectGscPosition(queries: SearchQueryDaily[]): IntelCard | null {
  const hits = queries.filter((q) =>
    q.kind === "query" && q.date === "" && (q.position ?? 0) >= 4 && (q.position ?? 0) <= 15 && q.impressions >= 80);
  if (hits.length < 8) return null;
  const top = [...hits].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  return card({
    id: "gsc-striking",
    owner: "site",
    title: `${hits.length} queries sitting in positions 4–15`,
    body: "Snapshot ranks from Queries.csv — not a measured drop. Do not invent a Δ position. Start with the pos 4–8 queries whose CTR is low; those are title problems, not ranking problems.",
    doThis: `7-day test: rewrite title + first paragraph for "${top[0].query}" and one sibling. Organic only — no ad changes.`,
    ifItWorks: "Clicks on those queries rise on the next GSC snapshot.",
    evidence: top.map((q) => `"${q.query}" pos ${q.position?.toFixed(1)} · ${q.impressions} impr`).join("; "),
    stake: 25,
    metric: `${hits.length} queries in pos 4–15`,
    action: "fix",
    check: check("query_ctr", top[0].query, "up", null, "pct", `CTR on "${top[0].query}"`),
    severity: "info",
  });
}

function detectLowCtrTitles(pages: SearchQueryDaily[]): IntelCard | null {
  const hits = pages.filter((p) => p.kind === "page" && p.impressions >= 2000 && (p.ctr ?? 100) < 1);
  if (!hits.length) return null;
  const top = [...hits].sort((a, b) => b.impressions - a.impressions).slice(0, 4);
  const path = top[0].query.replace(/^https?:\/\/[^/]+/, "");
  return card({
    id: "gsc-ctr",
    owner: "site",
    title: "PDPs and blogs are showing in Search with CTR under 1%",
    body: `${path} has ${fmtInt(top[0].impressions)} impressions at CTR ${top[0].ctr?.toFixed(2)}%. Google is showing the URL. The title/meta is not earning the click.`,
    doThis: `7-day test: new title + meta on ${path} — lead with the product noun + "grass-fed tallow". Repeat on the next two URLs in evidence.`,
    ifItWorks: "CTR on those URLs rises on the next Pages.csv snapshot.",
    evidence: top.map((p) => `${p.query.replace(/^https?:\/\/[^/]+/, "")} ${p.impressions} impr CTR ${p.ctr?.toFixed(2)}%`).join("; "),
    stake: round2(Math.min(top[0].impressions * 0.004, 180)),
    metric: `CTR ${top[0].ctr?.toFixed(2)}% — rewrite`,
    action: "fix",
    check: check("url_ctr", path, "up", round4((top[0].ctr ?? 0) * 2 || 1), "pct", `CTR on ${path}`),
  });
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function detectMobileLeak(ga: GaDaily[]): IntelCard | null {
  let mS = 0, mK = 0, dS = 0, dK = 0;
  for (const r of ga) {
    if (r.device === "mobile") {
      mS += r.sessions; mK += r.key_events;
    } else if (r.device === "desktop") {
      dS += r.sessions; dK += r.key_events;
    }
  }
  if (mS < 80 || dS < 40) return null;
  const mCvr = mK / mS;
  const dCvr = dK / dS;
  if (dCvr <= 0 || mCvr >= dCvr * 0.7) return null;
  const stake = round2((dCvr - mCvr) * mS * 25);
  return card({
    id: "mobile-cvr",
    title: "Mobile conversion is leaking vs desktop",
    body: `Mobile CVR ${(mCvr * 100).toFixed(1)}% on ${mS} sessions vs desktop ${(dCvr * 100).toFixed(1)}%.`,
    owner: "site",
    doThis: "7-day test: fix the top mobile landing (balm or deodorant PDP) — speed, above-the-fold price, sticky add-to-cart. Report the CVR before and after.",
    ifItWorks: "Mobile CVR closes at least a third of the gap to desktop.",
    evidence: `Mobile ${mK}/${mS}; desktop ${dK}/${dS}.`,
    stake: Math.max(stake, 40),
    metric: `mobile CVR ${(mCvr * 100).toFixed(1)}% vs ${(dCvr * 100).toFixed(1)}%`,
    action: "fix",
    check: check("mobile_cvr", null, "up", round4(mCvr + (dCvr - mCvr) / 3), "ratio", "Mobile conversion rate"),
  });
}

function landingRollup(ga: GaDaily[]) {
  const by = new Map<string, { sessions: number; bounce: number; bn: number; rev: number; ke: number }>();
  for (const r of ga) {
    const cur = by.get(r.landing_page) ?? { sessions: 0, bounce: 0, bn: 0, rev: 0, ke: 0 };
    cur.sessions += r.sessions;
    cur.rev += r.revenue;
    cur.ke += r.key_events;
    if (r.bounce_rate != null) {
      cur.bounce += r.bounce_rate * r.sessions;
      cur.bn += r.sessions;
    }
    by.set(r.landing_page, cur);
  }
  return [...by.entries()].map(([page, v]) => ({
    page,
    sessions: v.sessions,
    bounce: v.bn ? v.bounce / v.bn : null,
    rev: v.rev,
    ke: v.ke,
    cvr: v.sessions ? v.ke / v.sessions : 0,
  }));
}

function detectBounce(ga: GaDaily[]): IntelCard | null {
  const rows = landingRollup(ga);
  const edu = rows.filter((x) =>
    x.sessions >= 20 && (x.bounce ?? 0) >= 0.85 && x.ke < 1
    && (/\/blogs\/|\/pages\/tallow|\/pages\/about/i.test(x.page)));
  const winners = rows.filter((x) => /\/products\//.test(x.page) && x.rev >= 40)
    .sort((a, b) => b.rev - a.rev);
  const dest = winners[0]?.page ?? "/products/tallow-balm";
  const dest2 = winners[1]?.page ?? "/products/natural-tallow-deodorant-extra-strength";
  if (edu.length >= 2) {
    const sess = edu.reduce((s, x) => s + x.sessions, 0);
    return card({
      id: "bounce-sink",
      owner: "site",
      title: "Educational pages are a conversion dead-end",
      body: `${edu.length} content URLs bounced ${Math.round((edu[0].bounce ?? 0) * 100)}%+ with zero key events (${sess} sessions). Deodorant and balm PDPs are where money happens. The blogs are not a funnel until they point at a product.`,
      doThis: `7-day test: add a sticky product module above the fold on ${edu[0].page} and ${edu[1]?.page ?? "tallow-101"} — CTA to ${dest} and ${dest2}. One product, one button, no newsletter first.`,
      ifItWorks: "Those URLs record key events next Explore export, and bounce falls under 70%.",
      evidence: edu.slice(0, 5).map((s) => `${s.page} ${Math.round((s.bounce ?? 0) * 100)}% · ${s.sessions} sess · ${s.ke} ke`).join("; "),
      stake: round2(sess * 2.5),
      metric: `${sess} sess · 0 key events — fix`,
      action: "fix",
    check: check("page_key_events", edu[0].page, "up", 1, "count", `Key events on ${edu[0].page}`),
    });
  }
  const sinks = rows.filter((x) => x.sessions >= 20 && (x.bounce ?? 0) >= 0.7).sort((a, b) => b.sessions - a.sessions);
  if (!sinks.length) return null;
  const top = sinks[0];
  return card({
    id: "bounce-sink",
    owner: "site",
    title: `Bounce sink: ${top.page}`,
    body: `${Math.round((top.bounce ?? 0) * 100)}% bounce on ${top.sessions} sessions. Paid and organic are paying for exits.`,
    doThis: `7-day test: tighten the hero + one CTA on ${top.page} pointing at ${dest}.`,
    ifItWorks: "Bounce on that URL falls below 60% next Explore export.",
    evidence: sinks.slice(0, 3).map((s) => `${s.page} ${Math.round((s.bounce ?? 0) * 100)}% · ${s.sessions} sess`).join("; "),
    stake: round2(top.sessions * 2.5),
    metric: `${Math.round((top.bounce ?? 0) * 100)}% bounce — fix`,
    action: "fix",
    check: check("page_bounce", top.page, "down", 0.6, "ratio", `Bounce on ${top.page}`),
  });
}

function detectPdpWinners(ga: GaDaily[]): IntelCard | null {
  const rows = landingRollup(ga).filter((x) => /\/products\//.test(x.page) && x.sessions >= 20);
  const win = rows.filter((x) => x.rev >= 40 && x.ke >= 2).sort((a, b) => b.rev - a.rev);
  if (!win.length) return null;
  const top = win[0];
  return card({
    id: "pdp-winners",
    owner: "site",
    title: `${top.page} is already converting — protect it`,
    body: `${top.page} did ${money(top.rev)} and ${top.ke} key events on ${top.sessions} sessions (${(top.cvr * 100).toFixed(1)}% CVR). Do not redesign this PDP this week. Point the leaking blogs at it.`,
    doThis: `7-day test: every blog CTA and /pages/tallow-101 button goes to ${top.page}${win[1] ? ` or ${win[1].page}` : ""}. No theme overhaul.`,
    ifItWorks: "Blog-origin sessions start showing key events; PDP revenue holds or rises.",
    evidence: win.slice(0, 3).map((p) => `${p.page} ${money(p.rev)} · ${p.ke} ke · ${p.sessions} sess`).join("; "),
    stake: round2(top.rev * 0.25),
    metric: `${(top.cvr * 100).toFixed(1)}% CVR — protect`,
    action: "keep",
    check: check("page_key_events", top.page, "up", top.ke, "count", `Key events on ${top.page}`),
    severity: "info",
  });
}

function detectDeadPdp(ga: GaDaily[]): IntelCard | null {
  const dead = landingRollup(ga)
    .filter((x) => /\/products\//.test(x.page) && x.sessions >= 25 && x.ke < 1 && x.rev < 1)
    .sort((a, b) => b.sessions - a.sessions);
  if (!dead.length) return null;
  const top = dead[0];
  return card({
    id: "dead-pdp",
    owner: "site",
    title: `${top.page} gets traffic and zero conversions`,
    body: `${top.sessions} sessions, ${top.ke} key events, ${money(top.rev)}. Ads or organic are paying for a PDP that does not close.`,
    doThis: `7-day test: price/ATC visibility, first-image review, and a 2-product bundle on ${top.page}. If it is soap, cross-link deodorant + balm above the fold.`,
    ifItWorks: "That PDP records at least one key event next Explore export.",
    evidence: dead.slice(0, 3).map((p) => `${p.page} ${p.sessions} sess · ${p.ke} ke`).join("; "),
    stake: round2(top.sessions * 3),
    metric: `${top.sessions} sess · 0 conv — fix`,
    action: "fix",
    check: check("page_key_events", top.page, "up", 1, "count", `Key events on ${top.page}`),
  });
}

function detectTrackingHole(last: CampaignDaily[], ga: GaDaily[]): IntelCard | null {
  const metaSpend = last.filter((r) => r.platform === "meta").reduce((s, r) => s + r.spend, 0);
  if (metaSpend < 40) return null;
  const paidSocial = ga.filter((r) => /paid social/i.test(r.channel_group));
  const sess = paidSocial.reduce((s, r) => s + r.sessions, 0);
  const rev = paidSocial.reduce((s, r) => s + r.revenue, 0);
  if (sess > 15 && rev > 20) return null;
  return card({
    id: "meta-tracking",
    title: "Meta is spending; GA4 Paid Social is almost empty",
    body: `Meta ads conversion value is not GA4 revenue. Last 7d Meta spend ${money(metaSpend)} vs GA4 Paid Social ${sess} sessions / ${money(rev)}. That is a tracking hole, not a “Meta is free” story.`,
    doThis: "7-day test: ads lead + site — add `utm_source=facebook&utm_medium=paid` (or the Ads Manager UTMs) on every live Meta URL, verify the pixel fires on Purchase, and do not scale Meta until Paid Social sessions show up.",
    ifItWorks: "Next GA4 Explore shows Paid Social sessions in line with Meta clicks (not Organic Social).",
    evidence: `Meta spend ${money(metaSpend)}; GA4 Paid Social sessions ${sess}, revenue ${money(rev)}.`,
    stake: round2(metaSpend),
    metric: "Paid Social ≈ 0 — fix tracking",
    action: "fix",
    check: check("paid_social_sessions", null, "up", 25, "count", "GA4 Paid Social sessions"),
    owner: "ads",
    severity: "critical",
  });
}

function detectUnassigned(ga: GaDaily[]): IntelCard | null {
  const total = ga.reduce((s, r) => s + r.sessions, 0);
  const un = ga.filter((r) => /unassigned/i.test(r.channel_group)).reduce((s, r) => s + r.sessions, 0);
  if (total < 80) return null;
  const share = un / total;
  if (share <= 0.12) return null;
  const landings = landingRollup(ga.filter((r) => /unassigned/i.test(r.channel_group)))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 3);
  return card({
    id: "unassigned",
    owner: "site",
    title: `Unassigned is ${Math.round(share * 100)}% of GA4 sessions — and they do not convert`,
    body: `${un} of ${total} sessions arrive with no channel and produce ${ga.filter((r) => /unassigned/i.test(r.channel_group)).reduce((s, r) => s + r.key_events, 0)} key events. Until these are tagged, every channel report under-credits its real source and this traffic looks like it came from nowhere.`,
    doThis: `7-day test: add UTMs to Google + Meta landing URLs. Then add a session-channel override for ${landings[0]?.page ?? "the top Unassigned URL"}. The Unassigned pile is mostly blogs and /pages/tallow-101 — tag those templates.`,
    ifItWorks: "Unassigned share falls under 12% on the next Explore export.",
    evidence: `${un} / ${total} Unassigned. Top: ${landings.map((l) => `${l.page} ${l.sessions}`).join("; ")}.`,
    stake: round2(Math.min(un * 1.5, 400)),
    metric: `${Math.round(share * 100)}% Unassigned — fix`,
    action: "fix",
    check: check("unassigned_share", null, "down", 0.12, "ratio", "Unassigned share of sessions"),
    severity: share > 0.2 ? "critical" : "warn",
  });
}

function detectLastClick(last: CampaignDaily[], ga: GaDaily[]): IntelCard | null {
  const spend = last.reduce((s, r) => s + r.spend, 0);
  if (spend < 80) return null;
  const paidRev = ga.filter((r) => PAID_GA.test(r.channel_group)).reduce((s, r) => s + r.revenue, 0);
  const lc = spend > 0 ? paidRev / spend : 0;
  if (lc >= 1.5) return null;
  return card({
    id: "last-click",
    title: `Blended last-click is ${lc.toFixed(2)}x — mix cut`,
    body: `GA4 paid-channel revenue ${money(paidRev)} ÷ ads spend ${money(spend)} = ${lc.toFixed(2)}x. This is last-click, not ads conversion value. Do not use it as a campaign ROAS. It is a mix-cut trigger.`,
    doThis: "7-day test: cut the weaker platform 20% (see Google vs Meta Command) and hold Brand Search. Re-export GA4 in a week. Do not treat this last-click number as campaign ROAS.",
    ifItWorks: "Last-click paid ROAS ≥ 1.5x or ads-platform ROAS rises enough to justify the mix.",
    evidence: `GA4 paid revenue ${money(paidRev)}; ads spend ${money(spend)}.`,
    stake: round2(spend * (1.5 - lc) * 0.3),
    metric: `last-click ${lc.toFixed(2)}x — mix cut`,
    action: "shift",
    check: check("blended_roas", null, "up", null, "roas", "Blended ads ROAS"),
    severity: "warn",
  });
}

function winLose(camps: CampaignAgg[]): { wins: WinLoseRow[]; losses: WinLoseRow[] } {
  const rows: WinLoseRow[] = camps
    .filter((c) => c.spend >= 1)
    .map((c) => {
      let verdict: WinLoseRow["verdict"] = "hold";
      if (c.roas >= 1.5 && c.conversions > 0) verdict = "win";
      else if (c.roas < 1 && c.spend >= 1) verdict = "lose";
      return {
        platform: c.platform,
        campaign_name: c.campaign_name,
        spend: c.spend,
        conv_value: c.conv_value,
        roas: c.roas,
        conversions: c.conversions,
        verdict,
      };
    });
  return {
    wins: rows.filter((r) => r.verdict === "win").sort((a, b) => b.roas - a.roas),
    losses: rows.filter((r) => r.verdict === "lose").sort((a, b) => a.roas - b.roas || b.spend - a.spend),
  };
}

function gaRollup(ga: GaDaily[]) {
  const ch = new Map<string, { sessions: number; revenue: number; key_events: number; bounce: number; bn: number }>();
  const dev = new Map<string, { sessions: number; key_events: number; revenue: number }>();
  const land = new Map<string, { sessions: number; revenue: number; bounce: number; bn: number; key_events: number }>();
  let totalS = 0, un = 0, ps = 0, psearch = 0, xnet = 0, paidRev = 0;
  for (const r of ga) {
    totalS += r.sessions;
    if (/unassigned/i.test(r.channel_group)) un += r.sessions;
    if (/paid social/i.test(r.channel_group)) ps += r.sessions;
    if (/paid search/i.test(r.channel_group)) psearch += r.sessions;
    if (/cross-network/i.test(r.channel_group)) xnet += r.sessions;
    if (PAID_GA.test(r.channel_group)) paidRev += r.revenue;
    const c = ch.get(r.channel_group) ?? { sessions: 0, revenue: 0, key_events: 0, bounce: 0, bn: 0 };
    c.sessions += r.sessions; c.revenue += r.revenue; c.key_events += r.key_events;
    if (r.bounce_rate != null) { c.bounce += r.bounce_rate * r.sessions; c.bn += r.sessions; }
    ch.set(r.channel_group, c);
    const d = dev.get(r.device) ?? { sessions: 0, key_events: 0, revenue: 0 };
    d.sessions += r.sessions; d.key_events += r.key_events; d.revenue += r.revenue;
    dev.set(r.device, d);
    const l = land.get(r.landing_page) ?? { sessions: 0, revenue: 0, bounce: 0, bn: 0, key_events: 0 };
    l.sessions += r.sessions; l.revenue += r.revenue; l.key_events += r.key_events;
    if (r.bounce_rate != null) { l.bounce += r.bounce_rate * r.sessions; l.bn += r.sessions; }
    land.set(r.landing_page, l);
  }
  return {
    channels: [...ch.entries()].map(([channel, v]) => ({
      channel, sessions: v.sessions, revenue: round2(v.revenue), key_events: v.key_events,
      bounce: v.bn ? v.bounce / v.bn : null,
    })).sort((a, b) => b.sessions - a.sessions),
    devices: [...dev.entries()].map(([device, v]) => ({
      device, sessions: v.sessions, key_events: v.key_events, revenue: round2(v.revenue),
      cvr: v.sessions ? v.key_events / v.sessions : 0,
    })),
    landings: [...land.entries()].map(([page, v]) => ({
      page, sessions: v.sessions, revenue: round2(v.revenue),
      bounce: v.bn ? v.bounce / v.bn : null, key_events: v.key_events,
    })).sort((a, b) => b.sessions - a.sessions).slice(0, 16),
    unassigned_share: totalS ? un / totalS : 0,
    paid_social_sessions: ps,
    paid_search_sessions: psearch,
    cross_network_sessions: xnet,
    paid_revenue: round2(paidRev),
  };
}

export function buildIntel(opts: {
  campaigns: CampaignDaily[];
  queries: SearchQueryDaily[];
  ga: GaDaily[];
  range: IntelRangeDays;
  filter: IntelFilter;
  decisions?: IntelDecision[];
  today?: string;
  stats?: SourceStats;
}): IntelBundle {
  const freshness = buildFreshness({
    campaigns: opts.campaigns,
    queries: opts.queries,
    ga: opts.ga,
    today: opts.today,
    asOf: maxPaidDate(opts.campaigns) || maxPaidDate(opts.ga),
    range: opts.range,
    stats: opts.stats,
  });
  const paidMax = maxPaidDate(opts.campaigns);
  const gscMax = maxPaidDate(opts.queries.filter((q) => q.date));
  const gaMax = maxPaidDate(opts.ga);
  const asOf = paidMax || gaMax || gscMax;
  const range = opts.range;
  const filter = opts.filter;
  if (!asOf) {
    const emptyK = kpisOf([], "google");
    const emptyB = kpisOf([], "blended");
    return {
      as_of: null, range_days: range, filter,
      kpis: { google: emptyK, meta: kpisOf([], "meta"), blended: emptyB },
      wow: { last: emptyB, prior: emptyB },
      campaigns: [], products: [], cards: [], log: [], wins: [], losses: [], daily: [],
      gsc: { hidden: filter === "meta", queries: [], pages: [], chart: [] },
      ga4: {
        channels: [], devices: [], landings: [], unassigned_share: 0,
        paid_social_sessions: 0, paid_search_sessions: 0, cross_network_sessions: 0, paid_revenue: 0,
      },
      grok: { markdown: "No paid rows uploaded yet.", snapshot: emptySnapshot(), adsDesk: "", siteDesk: "" },
      brief: { headline: "", ads: "", site: "", adsHeadline: "", siteHeadline: "" },
      freshness,
      web_insights: buildWebInsights({
        campaigns: opts.campaigns,
        queries: opts.queries,
        ga: opts.ga,
        range,
        asOf: null,
      }),
      sources: { campaigns: 0, queries: opts.queries.length, ga: opts.ga.length },
    };
  }

  const last = filterCampaigns(opts.campaigns, asOf, range || 7, filter);
  const last7 = filterCampaigns(opts.campaigns, asOf, 7, filter);
  const prior7 = priorWindow(opts.campaigns, asOf, 7, filter);
  const camps = aggregateCampaigns(last);
  const gaWindow = gaInRange(opts.ga, asOf, range || 7);
  const productWeights = productWeightsFromGa(gaWindow);
  const products = aggregateProducts(last, productWeights);
  const google = kpisOf(last, "google");
  const meta = kpisOf(last, "meta");
  const blended = kpisOf(last, "blended");
  const wow = { last: kpisOf(last7, "blended"), prior: kpisOf(prior7, "blended") };
  const { wins, losses } = winLose(camps);
  const ga = gaInRange(opts.ga, asOf, range || 7);
  const ga7 = gaInRange(opts.ga, asOf, 7);
  const ga4 = gaRollup(ga);
  const hideGsc = filter === "meta";
  const queries = hideGsc ? [] : snapshotQueries(opts.queries, "query").slice(0, 40);
  const pages = hideGsc ? [] : snapshotQueries(opts.queries, "page").slice(0, 40);
  const chart = hideGsc ? [] : snapshotQueries(opts.queries, "chart");

  const last7Camps = aggregateCampaigns(last7);
  const rawCards = [
    detectMixCut(last7, last7Camps),
    detectReallocate(last7Camps),
    detectDeadSpend(last7, last7Camps, asOf),
    detectProductMix(aggregateProducts(last7, productWeights), last7Camps, productWeights),
    detectCollapse(last7, prior7),
    detectBrandSplit(last7Camps),
    detectFrequency(last7Camps),
    detectProspectRetarget(last7Camps),
    detectLostIsTrap(last7Camps),
    detectLostIs(last7Camps),
    detectPmaxHold(last7Camps),
    detectPmaxVsSearch(last7Camps),
    detectShoppingVsPmax(last7Camps),
    ...detectWorstLive(last7Camps),
    hideGsc ? null : detectGscTitleTrap(opts.queries),
    hideGsc ? null : detectGscClimb(opts.queries),
    hideGsc ? null : detectGscPosition(opts.queries),
    hideGsc ? null : detectLowCtrTitles(opts.queries),
    detectMobileLeak(ga7),
    detectBounce(ga7),
    detectPdpWinners(ga7),
    detectDeadPdp(ga7),
    detectTrackingHole(last7, ga7),
    detectUnassigned(ga7),
    detectLastClick(last7, ga7),
  ].filter((c): c is IntelCard => Boolean(c));
  // Two different questions, two different lookups:
  //   decided  — was THIS week's card already handled? (exact as_of)
  //   priorApplied — was it applied in an EARLIER week, so it can be graded now?
  const decided = new Map<string, IntelDecision>();
  const priorApplied = new Map<string, IntelDecision>();
  for (const d of opts.decisions ?? []) {
    if (d.as_of === asOf) {
      decided.set(d.card_id, d);
      continue;
    }
    if (d.status !== "applied" || d.as_of > asOf) continue;
    const prev = priorApplied.get(d.card_id);
    if (!prev || d.as_of > prev.as_of) priorApplied.set(d.card_id, d);
  }
  const siteCtx = buildSiteContext(ga7, opts.queries, asOf, 7);
  const promptCtx = { asOf, google, meta, blended, site: siteCtx };
  const measureCtx: MeasureContext = {
    camps: last7Camps,
    ga: ga7,
    queries: opts.queries,
    google: kpisOf(last7, "google"),
    meta: kpisOf(last7, "meta"),
    blended: kpisOf(last7, "blended"),
  };
  const withState = rawCards.map((c) => {
    const d = decided.get(c.id);
    const earlier = priorApplied.get(c.id);
    const status: DecisionStatus = d?.status ?? "open";
    // Grade the oldest measurable application: an earlier week if there is one,
    // otherwise this week's (which reads "too early" until new data lands).
    const source = earlier ?? (status === "applied" ? d : undefined);
    const chk = source?.check ?? c.check;
    return {
      ...c,
      status,
      decided_at: d?.applied_at ?? d?.dismissed_at ?? earlier?.applied_at ?? null,
      note: d?.note ?? earlier?.note ?? null,
      check: c.check,
      check_value: c.check ? measureCheck(c.check, measureCtx) : null,
      // Only applied cards get graded; a dismissed card has no claim to test.
      outcome: source && chk
        ? gradeOutcome({
            check: chk,
            baseline: source.baseline_value,
            baselineAsOf: source.baseline_as_of ?? source.as_of,
            currentAsOf: asOf,
            ctx: measureCtx,
          })
        : null,
      prompt: buildCardPrompt(c, promptCtx),
    };
  });
  // Recommendations are OPEN cards only (max 6 per desk = 12 total).
  // Applied/dismissed cards move to `log` so they never eat the recommendation budget.
  const order = (a: IntelCard, b: IntelCard) =>
    b.stake - a.stake || a.title.localeCompare(b.title);
  const open = withState.filter((c) => c.status === "open");
  const adsCards = open.filter((c) => c.owner === "ads").sort(order).slice(0, 6);
  const siteCards = open.filter((c) => c.owner === "site").sort(order).slice(0, 6);
  const cards = [...adsCards, ...siteCards];
  const log = withState.filter((c) => c.status !== "open").sort(order);
  const brief = buildBrief({
    asOf, google, meta, blended, wow, cards: adsCards, siteCards, site: siteCtx,
  });

  const grok = buildGrok({
    asOf, range, google, meta, blended, wow, camps, products, cards, brief,
    site: siteCtx, queries, pages, ga4,
  });
  const chartRows = opts.campaigns.filter((r) => filter === "all" || r.platform === filter);

  return {
    as_of: asOf,
    range_days: range,
    filter,
    kpis: { google, meta, blended },
    wow,
    brief,
    freshness,
    log,
    campaigns: camps,
    products,
    cards,
    wins,
    losses,
    daily: dailySeries(chartRows, asOf, range || 30),
    gsc: { hidden: hideGsc, queries, pages, chart },
    ga4,
    grok,
    web_insights: buildWebInsights({
      campaigns: last,
      queries: opts.queries,
      ga,
      range,
      asOf,
    }),
    sources: {
      campaigns: opts.campaigns.length,
      queries: opts.queries.length,
      ga: opts.ga.length,
    },
  };
}

function buildBrief(opts: {
  asOf: string;
  google: { spend: number; roas: number; conv_value: number };
  meta: { spend: number; roas: number; conv_value: number };
  blended: { spend: number; roas: number; conv_value: number };
  wow: { last: { spend: number; roas: number; conv_value: number }; prior: { spend: number; roas: number; conv_value: number } };
  cards: IntelCard[];
  siteCards: IntelCard[];
  site?: SitePromptContext;
}): IntelBrief {
  const { wow, google, meta, cards, siteCards, site: s } = opts;
  const revDrop = wow.prior.conv_value > 0
    ? Math.round((1 - wow.last.conv_value / wow.prior.conv_value) * 100)
    : 0;
  const adsHeadline = revDrop >= 15
    ? `As-of ${opts.asOf}: spend held near ${money(wow.last.spend)} while ads conversion value fell ${revDrop}% (${money(wow.prior.conv_value)} → ${money(wow.last.conv_value)}). Brand Search is the only ≥1.5x keep. Do not raise it to “make the week.”`
    : `As-of ${opts.asOf}: blended ${money(opts.blended.spend)} at ${roas(opts.blended.roas)}. Google ${roas(google.roas)} vs Meta ${roas(meta.roas)}.`;

  // Storefront framing: sessions and conversion, never spend or ROAS.
  let siteHeadline = `As-of ${opts.asOf}: storefront work below is ranked by the revenue it is leaking.`;
  if (s && s.sessions > 0) {
    const parts = [
      `As-of ${opts.asOf}: ${s.sessions.toLocaleString()} sessions converted at ${(s.cvr * 100).toFixed(1)}% for ${money(s.revenue)}.`,
    ];
    if (s.unassigned_share > 0.12) {
      parts.push(`${Math.round(s.unassigned_share * 100)}% of those sessions have no channel attribution, so the reporting under-credits every source.`);
    }
    if (s.desktop.cvr > 0 && s.mobile.cvr > 0) {
      const better = s.mobile.cvr >= s.desktop.cvr ? "Mobile" : "Desktop";
      const worse = better === "Mobile" ? "desktop" : "mobile";
      const bCvr = better === "Mobile" ? s.mobile.cvr : s.desktop.cvr;
      const wCvr = better === "Mobile" ? s.desktop.cvr : s.mobile.cvr;
      parts.push(`${better} converts at ${(bCvr * 100).toFixed(1)}% vs ${worse} at ${(wCvr * 100).toFixed(1)}%.`);
    }
    siteHeadline = parts.join(" ");
  }

  const ads = cards.length
    ? `Ads lead this week: ${cards.slice(0, 3).map((c) => c.title).join(" · ")}.`
    : "No open paid-media cards — everything in this window is applied or dismissed.";
  const site = siteCards.length
    ? `Web team this week: ${siteCards.slice(0, 3).map((c) => c.title).join(" · ")}.`
    : "No open site/conversion cards — everything in this window is applied or dismissed.";
  return { headline: adsHeadline, adsHeadline, siteHeadline, ads, site };
}

function buildSiteContext(ga: GaDaily[], queries: SearchQueryDaily[], asOf: string, range: IntelRangeDays): SitePromptContext {
  let sessions = 0, key_events = 0, revenue = 0, un = 0;
  const dev = new Map<string, { sessions: number; ke: number }>();
  for (const r of ga) {
    sessions += r.sessions;
    key_events += r.key_events;
    revenue += r.revenue;
    if (/unassigned/i.test(r.channel_group)) un += r.sessions;
    const d = dev.get(r.device) ?? { sessions: 0, ke: 0 };
    d.sessions += r.sessions;
    d.ke += r.key_events;
    dev.set(r.device, d);
  }
  const of = (name: string) => {
    const d = dev.get(name) ?? { sessions: 0, ke: 0 };
    return { sessions: d.sessions, cvr: d.sessions ? d.ke / d.sessions : 0 };
  };
  const start = range ? rangeStart(asOf, range) : null;
  const chart = queries.filter((q) => q.kind === "chart" && q.date && (!start || q.date >= start));
  const pages = landingRollup(ga)
    .filter((p) => /\/products\//.test(p.page) && p.rev > 0)
    .sort((a, b) => b.rev - a.rev)
    .slice(0, 3)
    .map((p) => ({ page: p.page, revenue: round2(p.rev), key_events: p.ke }));
  return {
    sessions,
    key_events,
    revenue: round2(revenue),
    cvr: sessions ? key_events / sessions : 0,
    mobile: of("mobile"),
    desktop: of("desktop"),
    unassigned_share: sessions ? un / sessions : 0,
    organic_clicks: chart.length ? chart.reduce((s, q) => s + q.clicks, 0) : null,
    top_pages: pages,
  };
}

function emptySnapshot() {
  return {
    kpis: {
      as_of: "", range_days: 7,
      google: kpisOf([], "google"), meta: kpisOf([], "meta"),
      blended_ads_roas: 0, ga4_paid_revenue: 0, ga4_last_click_roas: null,
    },
    campaigns: [], products: [], searchTop: [], landings: [], ga4Channels: [],
  };
}
