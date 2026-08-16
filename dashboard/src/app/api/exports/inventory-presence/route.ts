import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

const BUCKET = "cpa-exports";
const PREFIX = "inventory-presence";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown",
  csv: "text/csv",
};

const FILE_EXTENSIONS: Record<string, string> = {
  pdf: "pdf",
  md: "md",
  csv: "csv",
};

/**
 * GET /api/exports/inventory-presence?format=pdf|md|csv
 *
 * Downloads the latest CPA inventory presence export from Supabase Storage.
 * The Storage bucket is private — requires SUPABASE_SERVICE_KEY on the server.
 */
export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";

  if (!CONTENT_TYPES[format]) {
    return Response.json(
      { ok: false, error: `Invalid format: ${format}. Use pdf, md, or csv.` },
      { status: 400 },
    );
  }

  const key = `${PREFIX}/latest.${FILE_EXTENSIONS[format]}`;

  let sb;
  try {
    sb = getServerSupabase();
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: "Supabase not configured on this server",
        hint: "Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars on Vercel",
        detail: String(e),
      },
      { status: 500 },
    );
  }

  const { data, error } = await sb.storage.from(BUCKET).download(key);

  if (error || !data) {
    // Try to distinguish "bucket doesn't exist" vs "file doesn't exist" vs "auth"
    const msg = error?.message ?? "unknown";
    const isAuth =
      msg.includes("security") ||
      msg.includes("policy") ||
      msg.includes("not authorized") ||
      msg.includes("Invalid JWT");
    const hint = isAuth
      ? "The Storage bucket is private. Ensure SUPABASE_SERVICE_KEY (not anon key) is set on Vercel."
      : "Run the export: python -m src.main inventory-presence-export --format all";

    return Response.json(
      {
        ok: false,
        error: "Export file not found",
        bucket: BUCKET,
        key,
        supabase_error: msg,
        hint,
      },
      { status: 404 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `Tallowbourn_FBA_Inventory_Presence_${today}.${FILE_EXTENSIONS[format]}`;

  const bytes =
    data instanceof Blob
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

/**
 * POST /api/exports/inventory-presence
 *
 * Returns metadata about the latest export (validation, timestamp).
 * Also used to trigger regeneration by inserting an agent_jobs row.
 */
export async function POST(request: NextRequest) {
  let sb;
  try {
    sb = getServerSupabase();
  } catch (e) {
    return Response.json({
      available: false,
      error: "Supabase not configured",
      hint: "Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars",
    });
  }

  // Check if this is a regenerate request
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // empty body = metadata request
  }

  if (body.action === "regenerate") {
    // Insert a job row for the agent to pick up
    const { data: job, error: jobErr } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "export_cpa",
        status: "pending",
        payload: { formats: ["md", "csv", "pdf"], report: "inventory_presence" },
      })
      .select("id")
      .single();

    if (jobErr) {
      return Response.json({
        ok: false,
        error: "Failed to enqueue export job",
        detail: jobErr.message,
        hint: "Ensure the agent_jobs table exists in Supabase",
      });
    }

    return Response.json({
      ok: true,
      job_id: job?.id,
      message: "Export job enqueued. Agent will process it shortly.",
    });
  }

  // Default: return metadata
  const { data, error } = await sb.storage
    .from(BUCKET)
    .download(`${PREFIX}/meta.json`);

  if (error || !data) {
    const msg = error?.message ?? "unknown";
    const isAuth =
      msg.includes("security") ||
      msg.includes("policy") ||
      msg.includes("not authorized") ||
      msg.includes("Invalid JWT");

    return Response.json({
      available: false,
      error: isAuth
        ? "Storage auth failed — SUPABASE_SERVICE_KEY may be missing or wrong"
        : "No export found in Storage",
      hint: isAuth
        ? "On Vercel, set SUPABASE_SERVICE_KEY to the service_role key from Supabase dashboard > Settings > API"
        : "Run: python -m src.main inventory-presence-export --format all",
      bucket: BUCKET,
      key: `${PREFIX}/meta.json`,
      supabase_error: msg,
    });
  }

  const bytes =
    data instanceof Blob
      ? Buffer.from(await data.arrayBuffer())
      : Buffer.from(data as ArrayBuffer);

  const meta = JSON.parse(bytes.toString("utf-8"));
  return Response.json({ available: true, ...meta });
}
