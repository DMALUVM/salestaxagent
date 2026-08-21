import { readFile } from "node:fs/promises";
import path from "node:path";

import { getServerSupabase } from "@/lib/supabase-server";
import { buildReviewItems, type ReviewItem } from "@/lib/entity-review";

/** Repo root, relative to the dashboard's working directory. */
function repoPaths(file: string): string[] {
  return [
    path.join(process.cwd(), "..", "config", file),
    path.join(process.cwd(), "config", file),
  ];
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  for (const p of repoPaths(file)) {
    try {
      return JSON.parse(await readFile(p, "utf8"));
    } catch { /* try the next path */ }
  }
  return null;
}

/**
 * Home state + foreign-qualified states from config/entity_profile.json.
 *
 * Read from disk rather than duplicated in the database: the profile is the
 * single source of truth for where the entity is placed, and a copy would
 * drift. The dashboard runs from `dashboard/`, so the config sits one level up.
 * A missing or malformed file is not fatal — scope simply degrades to "all".
 */
async function readEntityProfile(): Promise<{
  homeState: string | null;
  foreignStates: string[];
  profile: Record<string, unknown>;
}> {
  const j = await readJson("entity_profile.json");
  if (!j) return { homeState: null, foreignStates: [], profile: {} };
  const fq = j.foreign_qualified;
  const foreign = Array.isArray(fq)
    ? fq.map((e: { state?: string }) => String(e?.state ?? "").toUpperCase()).filter(Boolean)
    : [];
  return {
    homeState: j.home_state ? String(j.home_state) : null,
    foreignStates: foreign,
    profile: j,
  };
}

/**
 * Contested obligations, read from the same rule file the Python engine uses.
 *
 * These live only in config — they are deliberately never written to
 * compliance_obligations, because writing them would make them look scheduled.
 * That is exactly why the page could not see them before.
 */
async function readReviewItems(profile: Record<string, unknown>): Promise<ReviewItem[]> {
  const j = await readJson("seed_entity_obligations.json");
  const rules = Array.isArray(j?.obligations) ? j!.obligations : [];
  return buildReviewItems(rules as never[], profile as never);
}

/**
 * GET /api/entity-obligations — entity, franchise and foreign-qualification
 * obligations. These are NOT sales-tax returns; they live in their own table
 * (compliance_obligations) so an entity fee can never render as an overdue
 * sales-tax remittance.
 *
 * Rows are written by `python -m src.main entity-calendar --apply`, which
 * recomputes due dates from config/seed_entity_obligations.json and
 * config/entity_profile.json. This route reads; it never invents a date.
 */
export async function GET() {
  try {
    // Profile and review items come from config, not the database, so they are
    // read first: a missing migration must not also hide the contested
    // obligations, which are the ones most likely to be overlooked.
    const { homeState, foreignStates, profile } = await readEntityProfile();
    const review = await readReviewItems(profile);

    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("compliance_obligations")
      .select("*")
      .order("due_date", { ascending: true, nullsFirst: false });

    if (error) {
      // The migration may not have been run yet. That is a setup step, not an
      // error worth breaking the page over.
      const missing = /compliance_obligations/.test(error.message ?? "");
      return Response.json({
        obligations: [],
        registered: [], homeState, foreignStates, review,
        available: false,
        setupHint: missing
          ? "Run supabase/migration_entity_obligations.sql, then `python -m src.main entity-calendar --apply`."
          : null,
        error: missing ? null : error.message,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = data ?? [];

    // Scope inputs. Registration comes from nexus_status — the same source the
    // sales-tax calendar uses — so "Registered for sales tax" means exactly
    // what it means everywhere else in the app.
    let registered: string[] = [];
    try {
      const r = await sb.from("nexus_status").select("state_code,is_registered");
      registered = (r.data ?? [])
        .filter((n) => n.is_registered === true)
        .map((n) => String(n.state_code));
    } catch { /* scope filter degrades to "all" */ }

    const open = rows.filter((r) => r.status === "open");
    const overdue = open.filter((r) => r.due_date && r.due_date < today);
    const upcoming = open.filter((r) => r.due_date && r.due_date >= today);
    // An obligation that applies but whose due date needs a profile date the
    // user has not supplied. Surfaced as a gap, never as a guessed deadline.
    const needsDate = open.filter((r) => !r.due_date);
    const settled = rows.filter((r) => r.status !== "open");

    return Response.json({
      obligations: rows,
      available: true,
      registered,
      homeState,
      foreignStates,
      review,
      overdue,
      upcoming,
      needsDate,
      settled,
      // Unfiltered counts. The page recomputes these under the selected
      // horizon/scope via lib/entity-filters.
      counts: {
        overdue: overdue.length,
        upcoming: upcoming.length,
        needsDate: needsDate.length,
        settled: settled.length,
      },
      today,
    });
  } catch (e) {
    return Response.json({
      obligations: [], registered: [], homeState: null, foreignStates: [],
      review: [], available: false, setupHint: null,
      error: e instanceof Error ? e.message : "unknown error",
    });
  }
}
