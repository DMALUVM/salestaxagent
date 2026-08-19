import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/costs — all sku_costs rows. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb.from("sku_costs").select("*").order("sku");
    if (error) {
      if (error.code === "PGRST205") return Response.json({ costs: [] });
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ costs: data ?? [] });
  } catch (e) {
    return Response.json({ costs: [] });
  }
}

/** PUT /api/costs — upsert a single SKU cost. */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { sku, cogs_per_unit, product_name, notes } = body;
    if (!sku) return Response.json({ error: "sku required" }, { status: 400 });
    const cost = parseFloat(cogs_per_unit);
    if (isNaN(cost) || cost < 0) return Response.json({ error: "Invalid cost" }, { status: 400 });

    const sb = getServerSupabase();
    const { error } = await sb.from("sku_costs").upsert({
      sku, cogs_per_unit: cost,
      product_name: product_name || null,
      notes: notes || null,
      source: "dashboard",
    }, { onConflict: "sku" });

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, sku });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/** POST /api/costs — bulk upsert (for file upload). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rows = body.rows as Array<{ sku: string; cogs_per_unit: number; product_name?: string }>;
    if (!Array.isArray(rows) || !rows.length) {
      return Response.json({ error: "rows array required" }, { status: 400 });
    }

    const sb = getServerSupabase();
    const cleaned = rows.filter((r) => r.sku && !isNaN(r.cogs_per_unit) && r.cogs_per_unit >= 0)
      .map((r) => ({
        sku: r.sku.trim(),
        cogs_per_unit: Math.round(r.cogs_per_unit * 10000) / 10000,
        product_name: r.product_name?.trim() || null,
        source: "upload",
      }));

    if (!cleaned.length) return Response.json({ error: "No valid rows" }, { status: 400 });

    const { error } = await sb.from("sku_costs").upsert(cleaned, { onConflict: "sku" });
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true, count: cleaned.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/costs?sku=X — delete a single SKU cost. */
export async function DELETE(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const sku = url.searchParams.get("sku");
    if (!sku) return Response.json({ error: "sku required" }, { status: 400 });

    const sb = getServerSupabase();
    await sb.from("sku_costs").delete().eq("sku", sku);
    return Response.json({ ok: true, sku });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
