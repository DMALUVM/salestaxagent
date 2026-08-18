import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/job-runs
 * Returns last run for each job (most recent per job_name).
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("job_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(100);

    if (error) {
      // Table may not exist yet
      if (error.code === "PGRST205" || error.message?.includes("schema cache")) {
        return Response.json({ runs: [], migration_needed: true });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    // Deduplicate to latest per job_name
    const latest = new Map<string, (typeof data)[0]>();
    for (const row of data ?? []) {
      if (!latest.has(row.job_name)) {
        latest.set(row.job_name, row);
      }
    }

    return Response.json({ runs: [...latest.values()] });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
