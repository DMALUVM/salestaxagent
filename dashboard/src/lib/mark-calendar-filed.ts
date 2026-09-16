import type { getServerSupabase } from "@/lib/supabase-server";

type ServerSb = ReturnType<typeof getServerSupabase>;

/** Mark matching current-cadence calendar rows filed through a period end. */
export async function markCalendarFiledThrough(
  sb: ServerSb,
  stateCode: string,
  periodEnd: string,
): Promise<void> {
  const { data: nexus } = await sb
    .from("nexus_status")
    .select("assigned_frequency")
    .eq("state_code", stateCode)
    .limit(1);
  const freq = nexus?.[0]?.assigned_frequency as string | null | undefined;
  const today = new Date().toISOString().slice(0, 10);
  let query = sb
    .from("filing_calendar")
    .update({ status: "filed", filed_date: today })
    .eq("state_code", stateCode)
    .lte("period_end", periodEnd)
    .in("status", ["pending", "late"]);
  if (freq) {
    query = query.eq("period_type", freq);
  }
  await query;
}
