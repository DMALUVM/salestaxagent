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
 * Returns the file with proper Content-Type and Content-Disposition headers.
 */
export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";

  if (!CONTENT_TYPES[format]) {
    return Response.json(
      { error: `Invalid format: ${format}. Use pdf, md, or csv.` },
      { status: 400 },
    );
  }

  const sb = getServerSupabase();
  const path = `${PREFIX}/latest.${FILE_EXTENSIONS[format]}`;

  try {
    const { data, error } = await sb.storage.from(BUCKET).download(path);

    if (error || !data) {
      return Response.json(
        {
          error: "Export not found. Run the export from the CLI first: python -m src.main inventory-presence-export --format all",
          detail: error?.message,
        },
        { status: 404 },
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const filename = `Tallowbourn_FBA_Inventory_Presence_${today}.${FILE_EXTENSIONS[format]}`;

    // data is a Blob in the browser SDK, ArrayBuffer in Node
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
  } catch (e) {
    return Response.json(
      { error: "Failed to download export", detail: String(e) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/exports/inventory-presence?format=meta
 *
 * Returns the metadata sidecar (validation results, timestamps).
 */
export async function POST() {
  // Return metadata about the latest export
  const sb = getServerSupabase();

  try {
    const { data, error } = await sb.storage
      .from(BUCKET)
      .download(`${PREFIX}/meta.json`);

    if (error || !data) {
      return Response.json({
        available: false,
        error: "No export found. Generate one from the CLI first.",
      });
    }

    const bytes = data instanceof Blob
      ? Buffer.from(await data.arrayBuffer())
      : Buffer.from(data as ArrayBuffer);

    const meta = JSON.parse(bytes.toString("utf-8"));
    return Response.json({ available: true, ...meta });
  } catch {
    return Response.json({ available: false, error: "Failed to read metadata" });
  }
}
