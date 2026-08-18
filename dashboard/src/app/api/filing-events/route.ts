import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/filing-events
 * Mark a filing period as filed. Inserts a filing_events row and
 * advances nexus_status.last_filed_through for the state.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { state_code, period_start, period_end, confirmation_number, amount_reported, notes } = body;

    if (!state_code || !period_end) {
      return Response.json({ error: "state_code and period_end required" }, { status: 400 });
    }

    const sb = getServerSupabase();

    // Insert filing event
    const { error: insertErr } = await sb.from("filing_events").insert({
      state_code,
      period_start: period_start || period_end,
      period_end,
      confirmation_number: confirmation_number || null,
      amount_reported: amount_reported ?? null,
      notes: notes || null,
    });

    if (insertErr) {
      // Table may not exist
      if (insertErr.code === "PGRST205" || insertErr.message?.includes("schema cache")) {
        return Response.json({ error: "filing_events table not found. Run supabase/migration_wave_a.sql" }, { status: 500 });
      }
      return Response.json({ error: insertErr.message }, { status: 500 });
    }

    // Advance last_filed_through on nexus_status
    const { error: updateErr } = await sb
      .from("nexus_status")
      .update({ last_filed_through: period_end })
      .eq("state_code", state_code);

    if (updateErr) {
      return Response.json({ error: `Filed event saved, but failed to advance filed_through: ${updateErr.message}` }, { status: 500 });
    }

    // Mark matching filing_calendar entries as filed
    try {
      await sb
        .from("filing_calendar")
        .update({ status: "filed", filed_date: new Date().toISOString().slice(0, 10) })
        .eq("state_code", state_code)
        .lte("period_end", period_end)
        .eq("status", "pending");
    } catch { /* best effort */ }

    return Response.json({ ok: true, state_code, period_end, filed_through_advanced: period_end });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
