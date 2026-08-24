import { deriveRoas, round2 } from "./csv";
import {
  aggregateCampaigns, aggregateProducts, dailySeries, filterCampaigns,
  gaInRange, kpisOf, maxPaidDate, priorWindow, snapshotQueries,
} from "./window";
import { buildGrok } from "./grok";
import type {
  CampaignAgg, CampaignDaily, GaDaily, IntelBundle, IntelCard, IntelFilter,
  IntelRangeDays, SearchQueryDaily, WinLoseRow,
} from "./types";

const PAID_GA = /^(paid search|paid social|cross-network|display|paid other)$/i;

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function roas(n: number): string {
  return `${n.toFixed(2)}x`;
}

function card(partial: Omit<IntelCard, "severity"> & { severity?: IntelCard["severity"] }): IntelCard {
  const stake = partial.stake;
  const severity = partial.severity ?? (stake >= 200 ? "critical" : stake >= 50 ? "warn" : "info");
  return { ...partial, severity };
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
  if (pmax) return pmax.campaign_name;
  return "the best non-brand Google campaign (never Brand Search)";
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
  return card({
    id: "mix-cut",
    title: `${loser.platform === "google" ? "Google" : "Meta"} is the expensive half of the mix`,
    body: `Last 7 days: Google ${money(g.spend)} at ${roas(g.roas)} vs Meta ${money(m.spend)} at ${roas(m.roas)}. Cut the loser — do not park the dollars on Brand Search.`,
    doThis: `7-day test: pull ${money(stake)} off ${loser.platform === "google" ? "Google non-brand / PMax" : "Meta prospecting"} and add it to ${target}. Leave Brand Search untouched.`,
    ifItWorks: `Blended ads ROAS rises toward ${roas(winner.roas)} without a Brand Search spend spike.`,
    evidence: `Google ROAS ${roas(g.roas)} on ${money(g.spend)}; Meta ROAS ${roas(m.roas)} on ${money(m.spend)}.`,
    stake,
    metric: `${loser.platform} ${roas(loser.roas)} — cut`,
    action: "shift",
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
  });
}

function shiftBack(asOf: string, days: number): string {
  const d = new Date(`${asOf}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function detectProductMix(products: ReturnType<typeof aggregateProducts>, camps: CampaignAgg[]): IntelCard | null {
  const real = products.filter((p) => p.product !== "other" && p.spend >= 20);
  if (real.length < 2) return null;
  const sorted = [...real].sort((a, b) => b.roas - a.roas);
  const win = sorted[0];
  const lose = sorted[sorted.length - 1];
  if (win.roas - lose.roas < 0.4 || lose.spend < 25) return null;
  const stake = round2(lose.spend * 0.3);
  const target = camps.find((c) => c.product === win.product && !c.is_brand && c.spend >= 1);
  return card({
    id: "product-mix",
    title: `${win.product} is carrying ${lose.product}`,
    body: `${win.product} ROAS ${roas(win.roas)} vs ${lose.product} ${roas(lose.roas)} on ${money(lose.spend)}. Shift creative and budget toward ${win.product}.`,
    doThis: `7-day test: cut ${lose.product} prospecting ~30% (${money(stake)}) and put it on ${target?.campaign_name ?? win.product + " non-brand"}.`,
    ifItWorks: `${win.product} spend share rises and blended product ROAS moves toward ${roas(win.roas)}.`,
    evidence: real.map((p) => `${p.product} ${money(p.spend)} ${roas(p.roas)}`).join("; "),
    stake,
    metric: `${lose.product} ${roas(lose.roas)} — shift`,
    action: "shift",
  });
}

function detectCollapse(last: CampaignDaily[], prior: CampaignDaily[]): IntelCard | null {
  const a = kpisOf(last, "blended");
  const b = kpisOf(prior, "blended");
  if (b.spend < 40 || a.spend < 20) return null;
  const revDrop = b.conv_value > 0 ? (b.conv_value - a.conv_value) / b.conv_value : 0;
  const roasDrop = b.roas > 0 ? (b.roas - a.roas) / b.roas : 0;
  if (revDrop < 0.25 && roasDrop < 0.3) return null;
  const stake = round2(Math.max(0, b.conv_value - a.conv_value));
  return card({
    id: "wow-collapse",
    title: "Last 7 days collapsed vs the prior 7",
    body: `Conv. value ${money(a.conv_value)} vs ${money(b.conv_value)} prior (${Math.round(revDrop * 100)}%). ROAS ${roas(a.roas)} vs ${roas(b.roas)}.`,
    doThis: "7-day test: freeze new tests, hold Brand Search, cut the worst non-brand loser 30%, and keep the best PMax/non-brand Search live.",
    ifItWorks: "This week's conv. value recovers at least halfway to the prior week.",
    evidence: `Last7 spend ${money(a.spend)} ROAS ${roas(a.roas)}; prior7 spend ${money(b.spend)} ROAS ${roas(b.roas)}.`,
    stake: Math.max(stake, 40),
    metric: `ROAS ${roas(a.roas)} vs ${roas(b.roas)} — diagnose`,
    action: "fix",
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
    return card({
      id: "brand-split",
      title: "Hold Brand Search — scale non-brand Google",
      body: `Brand is ${roas(bRoas)} on ${money(bSpend)}. Non-brand is ${roas(nRoas)} on ${money(nSpend)}. Brand is a hold, not a growth lever.`,
      doThis: `7-day test: do not raise Brand Search. Add ~15% budget to ${target}.`,
      ifItWorks: "Non-brand spend rises; brand spend stays flat; blended Google ROAS holds.",
      evidence: `Brand ${money(bSpend)} ${roas(bRoas)}; non-brand ${money(nSpend)} ${roas(nRoas)}.`,
      stake: round2(nSpend * 0.15),
      metric: `brand ${roas(bRoas)} keep · non-brand scale`,
      action: "keep",
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
    });
  }
  return null;
}

function detectFrequency(camps: CampaignAgg[]): IntelCard | null {
  const hot = camps.filter((c) => c.platform === "meta" && (c.frequency ?? 0) > 2.4 && c.spend >= 15);
  if (!hot.length) return null;
  const top = hot.sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))[0];
  return card({
    id: "meta-freq",
    title: `Meta frequency ${top.frequency!.toFixed(2)} on ${top.campaign_name}`,
    body: `Weighted frequency is above 2.4. That is fatigue, not reach. Refresh or tighten before you add budget.`,
    doThis: `7-day test: new creative on ${top.campaign_name}, or cut audience overlap. Do not raise spend until frequency is ≤ 2.2.`,
    ifItWorks: "Frequency falls toward 2.0 and CPA/ROAS stops sliding.",
    evidence: hot.map((c) => `${c.campaign_name} freq ${c.frequency!.toFixed(2)} ${money(c.spend)}`).join("; "),
    stake: round2(hot.reduce((s, c) => s + c.spend, 0) * 0.25),
    metric: `freq ${top.frequency!.toFixed(2)} — refresh`,
    action: "fix",
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
  });
}

function detectGscPosition(queries: SearchQueryDaily[]): IntelCard | null {
  const hits = queries.filter((q) =>
    q.kind === "query" && q.date === "" && (q.position ?? 0) >= 4 && (q.position ?? 0) <= 15 && q.impressions >= 80);
  if (!hits.length) return null;
  const top = [...hits].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  const stake = round2(top.reduce((s, q) => s + q.impressions, 0) * 0.02);
  return card({
    id: "gsc-striking",
    title: "Queries sitting in positions 4–15",
    body: "These are snapshot ranks from Queries.csv — not a measured drop. Do not invent a Δ position. They are in striking distance for title/internal-link work.",
    doThis: `7-day test: rewrite title + first paragraph for "${top[0].query}" and one sibling. No paid bid changes on Brand Search.`,
    ifItWorks: "Clicks on those queries rise on the next GSC snapshot. Position may or may not move.",
    evidence: top.map((q) => `"${q.query}" pos ${q.position?.toFixed(1)} · ${q.impressions} impr`).join("; "),
    stake: Math.max(stake, 25),
    metric: `${hits.length} queries in pos 4–15`,
    action: "fix",
    severity: "info",
  });
}

function detectLowCtrTitles(pages: SearchQueryDaily[]): IntelCard | null {
  const hits = pages.filter((p) => p.kind === "page" && p.impressions >= 2000 && (p.ctr ?? 100) < 1);
  if (!hits.length) return null;
  const top = [...hits].sort((a, b) => b.impressions - a.impressions).slice(0, 4);
  return card({
    id: "gsc-ctr",
    title: "High-impression pages with CTR under 1%",
    body: "Search is showing the URL. The title/meta is not earning the click.",
    doThis: `7-day test: new title + meta on ${top[0].query.replace(/^https?:\/\//, "")}.`,
    ifItWorks: "CTR on that URL rises on the next Pages.csv snapshot.",
    evidence: top.map((p) => `${p.query} ${p.impressions} impr CTR ${p.ctr?.toFixed(2)}%`).join("; "),
    stake: round2(top[0].impressions * 0.01),
    metric: `CTR ${top[0].ctr?.toFixed(2)}% — rewrite`,
    action: "fix",
  });
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
    doThis: "7-day test: fix the top mobile landing (balm or deodorant PDP) — speed, ATC, sticky add-to-cart. Do not raise ads until CVR moves.",
    ifItWorks: "Mobile CVR closes at least a third of the gap to desktop.",
    evidence: `Mobile ${mK}/${mS}; desktop ${dK}/${dS}.`,
    stake: Math.max(stake, 40),
    metric: `mobile CVR ${(mCvr * 100).toFixed(1)}% vs ${(dCvr * 100).toFixed(1)}%`,
    action: "fix",
  });
}

function detectBounce(ga: GaDaily[]): IntelCard | null {
  const by = new Map<string, { sessions: number; bounce: number; rev: number; n: number }>();
  for (const r of ga) {
    if (r.bounce_rate == null || r.sessions < 1) continue;
    const cur = by.get(r.landing_page) ?? { sessions: 0, bounce: 0, rev: 0, n: 0 };
    cur.sessions += r.sessions;
    cur.bounce += r.bounce_rate * r.sessions;
    cur.rev += r.revenue;
    cur.n += r.sessions;
    by.set(r.landing_page, cur);
  }
  const sinks = [...by.entries()]
    .map(([page, v]) => ({ page, sessions: v.sessions, bounce: v.bounce / v.n, rev: v.rev }))
    .filter((x) => x.sessions >= 20 && x.bounce >= 0.7)
    .sort((a, b) => b.sessions - a.sessions);
  if (!sinks.length) return null;
  const top = sinks[0];
  return card({
    id: "bounce-sink",
    title: `Bounce sink: ${top.page}`,
    body: `${Math.round(top.bounce * 100)}% bounce on ${top.sessions} sessions. Paid and organic are paying for exits.`,
    doThis: `7-day test: tighten the hero + one CTA on ${top.page}. If it is a blog, add a product module above the fold.`,
    ifItWorks: "Bounce on that URL falls below 60% next Explore export.",
    evidence: sinks.slice(0, 3).map((s) => `${s.page} ${Math.round(s.bounce * 100)}% · ${s.sessions} sess`).join("; "),
    stake: round2(top.sessions * 8),
    metric: `${Math.round(top.bounce * 100)}% bounce — fix`,
    action: "fix",
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
    doThis: "7-day test: verify Meta pixel + GA4 ads links + UTMs on every live Meta URL. Do not scale Meta until Paid Social sessions show up.",
    ifItWorks: "Next GA4 Explore shows Paid Social sessions in line with Meta clicks.",
    evidence: `Meta spend ${money(metaSpend)}; GA4 Paid Social sessions ${sess}, revenue ${money(rev)}.`,
    stake: round2(metaSpend),
    metric: "Paid Social ≈ 0 — fix tracking",
    action: "fix",
    severity: "critical",
  });
}

function detectUnassigned(ga: GaDaily[]): IntelCard | null {
  const total = ga.reduce((s, r) => s + r.sessions, 0);
  const un = ga.filter((r) => /unassigned/i.test(r.channel_group)).reduce((s, r) => s + r.sessions, 0);
  if (total < 80) return null;
  const share = un / total;
  if (share <= 0.12) return null;
  return card({
    id: "unassigned",
    title: `Unassigned is ${Math.round(share * 100)}% of GA4 sessions`,
    body: "More than 12% of sessions have no channel. Last-click ROAS and Paid Social reads are lying until this is fixed.",
    doThis: "7-day test: audit UTMs on Google + Meta landing URLs; set session channel group overrides for the worst Unassigned landings.",
    ifItWorks: "Unassigned share falls under 12% on the next Explore export.",
    evidence: `${un} / ${total} sessions Unassigned.`,
    stake: round2(un * 4),
    metric: `${Math.round(share * 100)}% Unassigned — fix`,
    action: "fix",
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
    doThis: "7-day test: cut the weaker platform 20% (see Google vs Meta) and hold Brand Search. Re-export GA4 in a week.",
    ifItWorks: "Last-click paid ROAS ≥ 1.5x or ads-platform ROAS rises enough to justify the mix.",
    evidence: `GA4 paid revenue ${money(paidRev)}; ads spend ${money(spend)}.`,
    stake: round2(spend * (1.5 - lc) * 0.3),
    metric: `last-click ${lc.toFixed(2)}x — mix cut`,
    action: "shift",
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
}): IntelBundle {
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
      campaigns: [], products: [], cards: [], wins: [], losses: [], daily: [],
      gsc: { hidden: filter === "meta", queries: [], pages: [], chart: [] },
      ga4: {
        channels: [], devices: [], landings: [], unassigned_share: 0,
        paid_social_sessions: 0, paid_search_sessions: 0, cross_network_sessions: 0, paid_revenue: 0,
      },
      grok: { markdown: "No paid rows uploaded yet.", snapshot: emptySnapshot() },
      sources: { campaigns: 0, queries: opts.queries.length, ga: opts.ga.length },
    };
  }

  const last = filterCampaigns(opts.campaigns, asOf, range || 7, filter);
  const last7 = filterCampaigns(opts.campaigns, asOf, 7, filter);
  const prior7 = priorWindow(opts.campaigns, asOf, 7, filter);
  const camps = aggregateCampaigns(last);
  const products = aggregateProducts(last);
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

  const cards = [
    detectMixCut(last7, aggregateCampaigns(last7)),
    detectReallocate(aggregateCampaigns(last7)),
    detectDeadSpend(last7, aggregateCampaigns(last7), asOf),
    detectProductMix(aggregateProducts(last7), aggregateCampaigns(last7)),
    detectCollapse(last7, prior7),
    detectBrandSplit(aggregateCampaigns(last7)),
    detectFrequency(aggregateCampaigns(last7)),
    detectProspectRetarget(aggregateCampaigns(last7)),
    detectLostIs(aggregateCampaigns(last7)),
    detectPmaxVsSearch(aggregateCampaigns(last7)),
    detectShoppingVsPmax(aggregateCampaigns(last7)),
    hideGsc ? null : detectGscPosition(opts.queries),
    hideGsc ? null : detectLowCtrTitles(opts.queries),
    detectMobileLeak(ga7),
    detectBounce(ga7),
    detectTrackingHole(last7, ga7),
    detectUnassigned(ga7),
    detectLastClick(last7, ga7),
  ].filter((c): c is IntelCard => Boolean(c))
    .sort((a, b) => b.stake - a.stake || a.title.localeCompare(b.title))
    .slice(0, 12);

  const grok = buildGrok({
    asOf, range, google, meta, blended, wow, camps, products, cards,
    queries, pages, ga4,
  });
  const chartRows = opts.campaigns.filter((r) => filter === "all" || r.platform === filter);

  return {
    as_of: asOf,
    range_days: range,
    filter,
    kpis: { google, meta, blended },
    wow,
    campaigns: camps,
    products,
    cards,
    wins,
    losses,
    daily: dailySeries(chartRows, asOf, range || 30),
    gsc: { hidden: hideGsc, queries, pages, chart },
    ga4,
    grok,
    sources: {
      campaigns: opts.campaigns.length,
      queries: opts.queries.length,
      ga: opts.ga.length,
    },
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
