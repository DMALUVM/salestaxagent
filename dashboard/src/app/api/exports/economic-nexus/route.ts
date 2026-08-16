import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

const BUCKET = "cpa-exports";
const PREFIX = "economic-nexus";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  json: "application/json",
};

/**
 * GET /api/exports/economic-nexus?format=pdf|csv|json
 * Downloads the latest economic nexus audit export from Supabase Storage.
 *
 * POST /api/exports/economic-nexus
 * Returns metadata or enqueues a regenerate job.
 */
export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";
  if (!CONTENT_TYPES[format]) {
    return Response.json({ ok: false, error: `Invalid format: ${format}` }, { status: 400 });
  }

  const sb = getServerSupabase();
  const key = `${PREFIX}/latest.${format}`;
  const { data, error } = await sb.storage.from(BUCKET).download(key);

  if (error || !data) {
    return Response.json({
      ok: false,
      error: "Export not found",
      bucket: BUCKET,
      key,
      hint: "Run: python -m src.main economic-nexus-audit --format all",
      supabase_error: error?.message,
    }, { status: 404 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `Economic_Nexus_Audit_${today}.${format}`;
  const bytes = data instanceof Blob
    ? Buffer.from(await data.arrayBuffer())
    : Buffer.from(data as ArrayBuffer);

  return new Response(bytes, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-cache",
    },
  });
}

export async function POST(request: NextRequest) {
  const sb = getServerSupabase();

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* metadata request */ }

  if (body.action === "regenerate") {
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({ job_type: "export_economic_audit", status: "pending", payload: {} })
      .select("id")
      .single();
    if (error) return Response.json({ ok: false, error: error.message });
    return Response.json({ ok: true, job_id: job?.id });
  }

  // Return metadata
  const { data, error } = await sb.storage.from(BUCKET).download(`${PREFIX}/meta.json`);
  if (error || !data) {
    return Response.json({ available: false, error: "No export found" });
  }
  const bytes = data instanceof Blob
    ? Buffer.from(await data.arrayBuffer())
    : Buffer.from(data as ArrayBuffer);
  const meta = JSON.parse(bytes.toString("utf-8"));
  return Response.json({ available: true, ...meta });
}
