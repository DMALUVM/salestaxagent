import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { generateEntries } from "@/lib/generate-filings";

/**
 * POST /api/generate-filings
 *
 * Generates filing_calendar rows for all registered states
 * (current year + next year). Uses upsert so safe to call repeatedly.
 *
 * Optionally accepts { state_code, frequency, due_day } to generate
 * for a single state (called from the Registrations save handler).
 * Casual (and any other non-periodic frequency) is a no-op.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sb = getServerSupabase();

    // Single-state mode (called from Registrations save)
    if (body.state_code && body.frequency) {
      const { data: existingOne } = await sb
        .from("filing_calendar")
        .select("state_code, period_type, period_label, status")
        .eq("state_code", body.state_code);
      const keep = new Set(
        (existingOne ?? [])
          .filter((r) => r.status === "filed" || r.status === "not_required" || r.status === "late")
          .map((r) => `${r.state_code}|${r.period_type}|${r.period_label}`),
      );
      const entries = generateEntries(
        body.state_code,
        body.frequency,
        body.due_day ?? 20,
        body.registration_date ?? null,
      ).filter((e) => !keep.has(`${e.state_code}|${e.period_type}|${e.period_label}`));
      if (entries.length > 0) {
        const { error } = await sb
          .from("filing_calendar")
          .upsert(entries, {
            onConflict: "state_code,period_type,period_label",
          });
        if (error) {
          return Response.json(
            { error: error.message },
            { status: 500 },
          );
        }
      }
      return Response.json({
        success: true,
        state_code: body.state_code,
        entries_created: entries.length,
      });
    }

    // All-states mode: generate for every registered state
    const { data: nexus, error: nErr } = await sb
      .from("nexus_status")
      .select("state_code, assigned_frequency, registration_date")
      .eq("is_registered", true);

    if (nErr) {
      return Response.json({ error: nErr.message }, { status: 500 });
    }

    const { data: existing } = await sb
      .from("filing_calendar")
      .select("state_code, period_type, period_label, status");
    const preserved = new Set(
      (existing ?? [])
        .filter((r) => r.status === "filed" || r.status === "not_required" || r.status === "late")
        .map((r) => `${r.state_code}|${r.period_type}|${r.period_label}`),
    );

    const { data: rules } = await sb
      .from("state_rules")
      .select("state_code, filing_frequency_default, typical_due_day");

    const ruleMap: Record<string, { freq: string; day: number }> = {};
    for (const r of rules ?? []) {
      ruleMap[r.state_code] = {
        freq: r.filing_frequency_default ?? "quarterly",
        day: r.typical_due_day ?? 20,
      };
    }

    let totalEntries = 0;
    const states: string[] = [];

    for (const n of nexus ?? []) {
      const sc = n.state_code;
      const freq =
        n.assigned_frequency ?? ruleMap[sc]?.freq ?? "quarterly";
      const day = ruleMap[sc]?.day ?? 20;
      const entries = generateEntries(sc, freq, day, n.registration_date ?? null)
        .filter((e) => !preserved.has(`${e.state_code}|${e.period_type}|${e.period_label}`));

      if (entries.length > 0) {
        const { error } = await sb
          .from("filing_calendar")
          .upsert(entries, {
            onConflict: "state_code,period_type,period_label",
          });
        if (!error) {
          totalEntries += entries.length;
          states.push(sc);
        }
      }
    }

    return Response.json({
      success: true,
      states,
      entries_created: totalEntries,
    });
  } catch (e) {
    return Response.json(
      {
        error: `Failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
}
