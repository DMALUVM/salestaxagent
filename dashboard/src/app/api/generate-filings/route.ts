import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/generate-filings
 *
 * Generates filing_calendar rows for all registered states
 * (current year + next year). Uses upsert so safe to call repeatedly.
 *
 * Optionally accepts { state_code, frequency, due_day } to generate
 * for a single state (called from the Registrations save handler).
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

// ---------------------------------------------------------------------------
// Entry generation (mirrors Python filing_calendar.py logic)
// ---------------------------------------------------------------------------

function generateEntries(
  stateCode: string,
  frequency: string,
  dueDay: number,
  registrationDate: string | null,
): Array<Record<string, unknown>> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const allEntries: Array<Record<string, unknown>> = [];

  for (const year of [currentYear, currentYear + 1]) {
    if (frequency === "monthly") {
      for (let month = 1; month <= 12; month++) {
        const pStart = isoDate(year, month, 1);
        const pEnd = lastDay(year, month);
        const dueMonth = month === 12 ? 1 : month + 1;
        const dueYear = month === 12 ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "monthly",
          period_label: `${year}-${String(month).padStart(2, "0")}`,
          period_start: pStart,
          period_end: pEnd,
          due_date: safeDate(dueYear, dueMonth, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "quarterly") {
      const qs: [string, number, number, number][] = [
        ["Q1", 1, 3, 4],
        ["Q2", 4, 6, 7],
        ["Q3", 7, 9, 10],
        ["Q4", 10, 12, 1],
      ];
      for (const [label, sm, em, dm] of qs) {
        const dueYear = dm < sm ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "quarterly",
          period_label: `${year}-${label}`,
          period_start: isoDate(year, sm, 1),
          period_end: lastDay(year, em),
          due_date: safeDate(dueYear, dm, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "semi_annual") {
      for (const [label, sm, em, dm] of [
        ["H1", 1, 6, 7],
        ["H2", 7, 12, 1],
      ] as [string, number, number, number][]) {
        const dueYear = dm < sm ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "semi_annual",
          period_label: `${year}-${label}`,
          period_start: isoDate(year, sm, 1),
          period_end: lastDay(year, em),
          due_date: safeDate(dueYear, dm, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "annual" || frequency === "casual") {
      allEntries.push({
        state_code: stateCode,
        period_type: frequency,
        period_label: String(year),
        period_start: isoDate(year, 1, 1),
        period_end: isoDate(year, 12, 31),
        due_date: safeDate(year + 1, 1, dueDay),
        status: "pending",
      });
    }
  }

  // Skip periods that end entirely before registration date.
  // Only create filing obligations from registration forward.
  if (registrationDate) {
    return allEntries.filter((e) => (e.period_end as string) >= registrationDate);
  }
  return allEntries;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number): string {
  const d = new Date(y, m, 0).getDate();
  return isoDate(y, m, d);
}

function safeDate(y: number, m: number, d: number): string {
  const max = new Date(y, m, 0).getDate();
  return isoDate(y, m, Math.min(d, max));
}
