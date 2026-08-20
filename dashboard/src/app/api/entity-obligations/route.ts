import { getServerSupabase } from "@/lib/supabase-server";

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
        available: false,
        setupHint: missing
          ? "Run supabase/migration_entity_obligations.sql, then `python -m src.main entity-calendar --apply`."
          : null,
        error: missing ? null : error.message,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = data ?? [];

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
      overdue,
      upcoming,
      needsDate,
      settled,
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
      obligations: [], available: false, setupHint: null,
      error: e instanceof Error ? e.message : "unknown error",
    });
  }
}
