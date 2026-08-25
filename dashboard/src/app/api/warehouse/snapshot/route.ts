import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  exportWarehouseSnapshot,
  gzipSnapshot,
  parseSnapshotBytes,
  restoreWarehouseSnapshot,
} from "@/lib/warehouse-snapshot";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * GET /api/warehouse/snapshot — download gzip JSON bundle of all warehouse tables.
 * POST /api/warehouse/snapshot — restore from uploaded .json.gz (merge upsert).
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const snapshot = await exportWarehouseSnapshot(sb);
    const gz = gzipSnapshot(snapshot);
    const stamp = snapshot.exported_at.slice(0, 10);
    const filename = `warehouse_snapshot_${stamp}.json.gz`;

    return new Response(gz, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(gz.length),
        "X-Snapshot-Rows": String(
          Object.values(snapshot.table_meta).reduce((n, m) => n + m.row_count, 0),
        ),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const dryRun = request.nextUrl.searchParams.get("dry_run") === "1";
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ ok: false, error: "No file provided (field: file)" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json({
        ok: false,
        error: `File too large (${file.size} bytes). Max ${MAX_UPLOAD_BYTES} bytes.`,
      }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const snapshot = parseSnapshotBytes(buf);
    const sb = getServerSupabase();
    const summary = await restoreWarehouseSnapshot(sb, snapshot, dryRun);

    return Response.json({
      ok: summary.errors.length === 0,
      dry_run: dryRun,
      exported_at: summary.exported_at,
      tables_processed: summary.tables_processed,
      total_upserted: summary.total_upserted,
      unknown_tables: summary.unknown_tables,
      errors: summary.errors,
      tables: summary.tables.filter((t) => t.rows_in_backup > 0 || t.status === "error"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
