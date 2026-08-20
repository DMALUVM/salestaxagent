import fs from "node:fs";
import path from "node:path";

/**
 * Campaign role taxonomy, read from the SAME file the Python engine uses
 * (config/ads_strategy.json) so the dashboard and the actions engine can never
 * disagree about what a campaign is for.
 *
 * Server-only: reads from disk at first use and caches. If the file is not
 * reachable (e.g. a deploy that ships only the dashboard directory), the
 * embedded defaults below keep the page working — they are a copy of the same
 * patterns, so a divergence shows up as roles going stale, not as a crash.
 */

export type CampaignRole = "discovery" | "profit" | "ranking" | "defense";

interface RoleConfig {
  order: CampaignRole[];
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  patterns: Record<string, string[]>;
  default: CampaignRole;
}

const FALLBACK: RoleConfig = {
  order: ["defense", "ranking", "profit", "discovery"],
  labels: { discovery: "Discovery", profit: "Profit", ranking: "Ranking", defense: "Defense" },
  descriptions: {},
  patterns: {
    defense: ["asin defense", "\\bdefense\\b", "\\bbrand(ed)?\\b", "competitor defense"],
    ranking: ["asin offense", "\\boffense\\b", "\\brank(ing)?\\b", "\\blaunch\\b", "hero kw"],
    profit: ["\\bexact\\b", "\\bpm\\b", "harvest"],
    discovery: ["\\bauto\\b", "\\bbroad\\b", "\\bphrase\\b", "loose match", "catch all", "discovery", "research"],
  },
  default: "discovery",
};

let cached: { cfg: RoleConfig; compiled: Array<[CampaignRole, RegExp[]]>; source: string } | null = null;

function load() {
  if (cached) return cached;
  let cfg = FALLBACK;
  let source = "embedded-fallback";
  for (const candidate of [
    path.join(process.cwd(), "..", "config", "ads_strategy.json"),
    path.join(process.cwd(), "config", "ads_strategy.json"),
  ]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (raw?.roles?.patterns) {
        cfg = raw.roles as RoleConfig;
        source = candidate;
        break;
      }
    } catch { /* try next */ }
  }
  const compiled = cfg.order.map((role) =>
    [role, (cfg.patterns[role] ?? []).map((p) => new RegExp(p, "i"))] as [CampaignRole, RegExp[]]
  );
  cached = { cfg, compiled, source };
  return cached;
}

/** Role for a campaign name. First match in configured order wins. */
export function classifyCampaign(campaignName: string): CampaignRole {
  const { cfg, compiled } = load();
  const name = campaignName ?? "";
  for (const [role, patterns] of compiled) {
    if (patterns.some((p) => p.test(name))) return role;
  }
  return cfg.default;
}

export function roleLabels(): Record<string, string> {
  return load().cfg.labels;
}

export function roleDescriptions(): Record<string, string> {
  return load().cfg.descriptions ?? {};
}

export function roleOrder(): CampaignRole[] {
  return load().cfg.order;
}

/** Where the taxonomy came from — surfaced so a stale fallback is visible. */
export function roleConfigSource(): string {
  return load().source;
}
