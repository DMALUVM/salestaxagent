import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PPC strategy settings: file defaults + operator overrides from Supabase.
 *
 * Server-only. Mirrors src/amazon_ads/strategy.py — same file, same merge
 * semantics, same allowlist — so the nightly Python jobs and this route can
 * never disagree about what the targets are.
 *
 * Only `roles.targets` is overridable. Storing anything else would be a key no
 * reader honours, so the writer rejects it rather than accepting a setting that
 * silently does nothing.
 */

export const SETTINGS_TABLE = "ads_strategy_settings";
export const SETTINGS_ROW_ID = "default";

export interface RoleTarget { min: number; max: number }
export type RoleTargets = Record<string, RoleTarget | null>;

export interface StrategyDoc {
  roles?: {
    order?: string[];
    labels?: Record<string, string>;
    targets?: RoleTargets;
    [k: string]: unknown;
  };
  thresholds?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Read config/ads_strategy.json. Cached — the file only changes on deploy. */
let fileCache: { doc: StrategyDoc; source: string } | null = null;
export function fileDefaults(): { doc: StrategyDoc; source: string } {
  if (fileCache) return fileCache;
  for (const candidate of [
    path.join(process.cwd(), "..", "config", "ads_strategy.json"),
    path.join(process.cwd(), "config", "ads_strategy.json"),
  ]) {
    try {
      const doc = JSON.parse(fs.readFileSync(candidate, "utf8")) as StrategyDoc;
      if (doc?.roles) {
        fileCache = { doc, source: candidate };
        return fileCache;
      }
    } catch { /* try next */ }
  }
  fileCache = { doc: {}, source: "unavailable" };
  return fileCache;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive merge; override wins, missing keys fall through to base. */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k])
      ? deepMerge(out[k] as Record<string, unknown>, v)
      : v;
  }
  return out as T;
}

export interface MergedStrategy {
  merged: StrategyDoc;
  defaults: StrategyDoc;
  overrides: Record<string, unknown>;
  /** True when the operator has saved anything at all. */
  isCustom: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** False when the settings table has not been created yet. */
  storageAvailable: boolean;
  source: string;
}

export async function loadMergedStrategy(sb: SupabaseClient): Promise<MergedStrategy> {
  const { doc: defaults, source } = fileDefaults();
  let overrides: Record<string, unknown> = {};
  let updatedAt: string | null = null;
  let updatedBy: string | null = null;
  let storageAvailable = false;

  try {
    const { data, error } = await sb.from(SETTINGS_TABLE)
      .select("settings,updated_at,updated_by").eq("id", SETTINGS_ROW_ID).limit(1);
    if (error) throw error;
    storageAvailable = true;
    const row = data?.[0];
    if (row && isPlainObject(row.settings)) overrides = row.settings as Record<string, unknown>;
    updatedAt = row?.updated_at ?? null;
    updatedBy = row?.updated_by ?? null;
  } catch {
    // Table absent (migration not run) or unreachable — defaults still apply.
    storageAvailable = false;
  }

  return {
    merged: deepMerge(defaults as Record<string, unknown>, overrides) as StrategyDoc,
    defaults,
    overrides,
    isCustom: Object.keys(overrides).length > 0,
    updatedAt, updatedBy, storageAvailable, source,
  };
}

export function roleTargetsOf(doc: StrategyDoc): RoleTargets {
  const t = doc.roles?.targets;
  if (!isPlainObject(t)) return {};
  // Config files carry "_comment" documentation keys; they are not roles and
  // must not reach the editor as an extra row.
  return Object.fromEntries(
    Object.entries(t).filter(([k]) => !k.startsWith("_"))
  ) as RoleTargets;
}

export function roleTargetOf(doc: StrategyDoc, role: string): RoleTarget | null {
  const t = roleTargetsOf(doc)[role];
  if (!t || typeof t.min !== "number" || typeof t.max !== "number") return null;
  return { min: t.min, max: t.max };
}

/** Same comparison as share_status() in strategy.py. */
export function shareStatusOf(
  doc: StrategyDoc, role: string, sharePct: number,
): "above" | "below" | "in_range" | null {
  const t = roleTargetOf(doc, role);
  if (!t) return null;
  if (sharePct > t.max) return "above";
  if (sharePct < t.min) return "below";
  return "in_range";
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cleaned: RoleTargets;
}

/**
 * Validate a submitted target map. Rejects rather than clamps: silently
 * "fixing" a number the operator typed would hide the mistake.
 */
export function validateRoleTargets(input: unknown, knownRoles: string[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleaned: RoleTargets = {};

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["targets must be an object"], warnings, cleaned };
  }

  for (const [role, band] of Object.entries(input)) {
    if (!knownRoles.includes(role)) {
      errors.push(`unknown role "${role}"`);
      continue;
    }
    if (band === null) { cleaned[role] = null; continue; } // opt this role out
    if (!isPlainObject(band)) { errors.push(`${role}: band must be {min,max} or null`); continue; }

    const min = Number((band as Record<string, unknown>).min);
    const max = Number((band as Record<string, unknown>).max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      errors.push(`${role}: min and max must be numbers`); continue;
    }
    if (min < 0 || min > 100 || max < 0 || max > 100) {
      errors.push(`${role}: min and max must be between 0 and 100`); continue;
    }
    if (min > max) { errors.push(`${role}: min (${min}%) is above max (${max}%)`); continue; }
    cleaned[role] = { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
  }

  // Advisory only — spend shares must total 100%, so bands that cannot
  // accommodate that are worth flagging without blocking the save.
  const bands = Object.values(cleaned).filter((b): b is RoleTarget => b !== null);
  if (bands.length) {
    const minSum = bands.reduce((s, b) => s + b.min, 0);
    const maxSum = bands.reduce((s, b) => s + b.max, 0);
    if (minSum > 100) {
      warnings.push(`Minimums total ${minSum}% — above 100%, so at least one role must always read below target.`);
    }
    if (bands.length === knownRoles.length && maxSum < 100) {
      warnings.push(`Maximums total ${maxSum}% — below 100%, so at least one role must always read above target.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, cleaned };
}
