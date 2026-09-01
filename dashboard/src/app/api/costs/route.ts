import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { attachCostProductNames, skuCostWriteRow } from "@/lib/costs-product-name";

/** GET /api/costs — sku_costs rows, product_name from sku_velocity when null. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb.from("sku_costs").select("*").order("sku");
    if (error) {
      if (error.code === "PGRST205") return Response.json({ costs: [] });
      return Response.json({ error: error.message }, { status: 500 });
    }

    const costs = data ?? [];
    const { data: velocity, error: velError } = await sb
      .from("sku_velocity")
      .select("sku,product_name");
    if (velError && velError.code !== "PGRST205") {
      // Velocity is display-only fallback — still return costs.
      return Response.json({ costs: attachCostProductNames(costs, []) });
    }
    return Response.json({ costs: attachCostProductNames(costs, velocity ?? []) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "costs failed" },
      { status: 500 },
    );
  }
}

/** PUT /api/costs — upsert cogs_per_unit and product_name onto sku_costs. */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { sku, cogs_per_unit, product_name, notes } = body;
    if (!sku) return Response.json({ error: "sku required" }, { status: 400 });
    const cost = parseFloat(cogs_per_unit);
    if (isNaN(cost) || cost < 0) return Response.json({ error: "Invalid cost" }, { status: 400 });

    const sb = getServerSupabase();
    const { error } = await sb.from("sku_costs").upsert(
      skuCostWriteRow({
        sku,
        cogs_per_unit: cost,
        product_name,
        notes,
        source: "dashboard",
        includeProductName: Object.prototype.hasOwnProperty.call(body, "product_name"),
      }),
      { onConflict: "sku" },
    );

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

    const cleaned = rows
      .filter((r) => r.sku && !isNaN(r.cogs_per_unit) && r.cogs_per_unit >= 0)
      .map((r) =>
        skuCostWriteRow({
          sku: r.sku.trim(),
          cogs_per_unit: Math.round(r.cogs_per_unit * 10000) / 10000,
          product_name: r.product_name,
          source: "upload",
          includeProductName: Object.prototype.hasOwnProperty.call(r, "product_name"),
        }),
      );

    if (!cleaned.length) return Response.json({ error: "No valid rows" }, { status: 400 });

    const sb = getServerSupabase();
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
