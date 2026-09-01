/**
 * Branded vs non-branded classification for search queries.
 *
 * Mirrors src/amazon_ads/brand_terms.py and reads the same
 * config/brand_terms.json so /ppc bleeders, the organic-rank gate, and the
 * branded-share tracker cannot disagree about what "branded" means.
 *
 * Matching is conservative: whole-token / whole-phrase only. Naive substring
 * matching would classify "beef tallow lip balm" as branded because "tallow"
 * sits inside "tallowbourn".
 */

import fs from "node:fs";
import path from "node:path";

export interface BrandRules {
  phrases: string[];
  tokens: string[];
}

function normalize(text: string | null | undefined): string {
  if (!text) return "";
  let s = String(text).toLowerCase();
  s = s.replace(/[’'`.]/g, " ");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function loadRules(): BrandRules {
  for (const candidate of [
    path.join(process.cwd(), "..", "config", "brand_terms.json"),
    path.join(process.cwd(), "config", "brand_terms.json"),
  ]) {
    try {
      const doc = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        phrases?: unknown[];
        tokens?: unknown[];
      };
      const phrases = [...new Set(
        (doc.phrases ?? []).map((x) => normalize(String(x))).filter(Boolean),
      )].sort((a, b) => b.length - a.length);
      const tokensRaw = (doc.tokens ?? []).map((x) => normalize(String(x))).filter(Boolean);
      const tokens = tokensRaw.filter((t) => !t.includes(" "));
      const extraPhrases = tokensRaw.filter((t) => t.includes(" "));
      return {
        phrases: [...new Set([...phrases, ...extraPhrases])].sort((a, b) => b.length - a.length),
        tokens,
      };
    } catch {
      /* try next */
    }
  }
  return { phrases: [], tokens: [] };
}

let cached: BrandRules | null = null;

export function brandRules(): BrandRules {
  if (!cached) cached = loadRules();
  return cached;
}

/** Test helper — drop the process-wide cache between cases. */
export function resetBrandRulesForTests(): void {
  cached = null;
}

export function matchBrandRule(query: string, rules: BrandRules = brandRules()): string | null {
  const q = normalize(query);
  if (!q) return null;
  const parts = q.split(" ");
  const tokenSet = new Set(parts);
  for (const t of rules.tokens) {
    if (tokenSet.has(t)) return t;
  }
  for (const p of rules.phrases) {
    const pt = p.split(" ");
    const n = pt.length;
    if (!n) continue;
    for (let i = 0; i <= parts.length - n; i++) {
      if (pt.every((tok, j) => parts[i + j] === tok)) return p;
    }
  }
  return null;
}

export function isBranded(query: string, rules?: BrandRules): boolean {
  return matchBrandRule(query, rules ?? brandRules()) !== null;
}

export type BrandLane = "branded" | "nonbranded";

export function laneOf(query: string, rules?: BrandRules): BrandLane {
  return isBranded(query, rules) ? "branded" : "nonbranded";
}
