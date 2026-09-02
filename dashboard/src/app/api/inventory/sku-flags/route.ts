import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const TABLE_MISSING =
  "inventory_sku_flags table not found — run supabase/migration_inventory_sku_flags.sql, then try again.";

function isMissingTable(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("inventory_sku_flags") && (
    m.includes("does not exist") ||
    m.includes("schema cache") ||
    m.includes("could not find")
  );
}

/**
 * POST /api/inventory/sku-flags
 *
 * Persist an operator "not selling" flag. Service-role write — the client
 * never sees the key. Overview alerts hide the SKU; inventory rows stay.
 * Does not write to Amazon. Does not change Holt / replen qty.
 *
 * Body: { sku: string, not_selling: boolean }
 */
export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
    }

    const extra = Object.keys(body).filter((k) => k !== "sku" && k !== "not_selling");
    if (extra.length) {
      return Response.json({
        ok: false,
        error: `Only "sku" and "not_selling" are accepted; received ${extra.join(", ")}`,
      }, { status: 400 });
    }

    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    if (!sku || sku.length > 128) {
      return Response.json({ ok: false, error: "sku is required" }, { status: 400 });
    }
    if (typeof body.not_selling !== "boolean") {
      return Response.json({ ok: false, error: "not_selling must be a boolean" }, { status: 400 });
    }

    const sb = getServerSupabase();
    const { error } = await sb.from("inventory_sku_flags").upsert(
      {
        sku,
        not_selling: body.not_selling,
        updated_at: new Date().toISOString(),
        updated_by: "dashboard",
      },
      { onConflict: "sku" },
    );

    if (error) {
      if (isMissingTable(error.message)) {
        return Response.json({ ok: false, error: TABLE_MISSING }, { status: 503 });
      }
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, sku, not_selling: body.not_selling });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
