import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/amazon-ops — Sales & Traffic + Reimbursements with title resolution. */
export async function GET() {
  try {
    const sb = getServerSupabase();

    let traffic: unknown[] = [];
    let asinTraffic: Record<string, unknown>[] = [];
    let reimbursements: unknown[] = [];

    try {
      const r = await sb.from("amazon_sales_traffic").select("*").order("date", { ascending: false }).limit(30);
      traffic = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("amazon_asin_traffic").select("*").order("units_ordered", { ascending: false }).limit(20);
      asinTraffic = (r.data ?? []) as Record<string, unknown>[];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("fba_reimbursements").select("*").order("approval_date", { ascending: false }).limit(100);
      reimbursements = r.data ?? [];
    } catch { /* table may not exist */ }

    // Resolve parent ASIN → product title from existing data sources.
    // S&T report only gives parent ASINs; titles come from child ASIN data.
    if (asinTraffic.length > 0) {
      // Build ASIN→title map from velocity (has child ASIN + product_name)
      const titleMap = new Map<string, string>();
      // Also build parent→group title (first child's product line)
      const parentTitleMap = new Map<string, string>();

      try {
        const vel = await sb.from("sku_velocity").select("asin,product_name");
        for (const v of vel.data ?? []) {
          if (v.asin && v.product_name) {
            titleMap.set(v.asin, v.product_name);
          }
        }
      } catch { /* ok */ }

      // Also check fba_returns for additional ASIN→title mappings
      try {
        const ret = await sb.from("fba_returns").select("asin,product_name").limit(200);
        for (const r of ret.data ?? []) {
          if (r.asin && r.product_name && !titleMap.has(r.asin)) {
            titleMap.set(r.asin, r.product_name);
          }
        }
      } catch { /* ok */ }

      // Check if amazon_asin_traffic itself has product_name
      // Also try direct match (parent ASIN might be in our data)
      for (const row of asinTraffic) {
        const parentAsin = row.parent_asin as string;
        if (row.product_name) continue; // already has title

        // Direct match
        if (titleMap.has(parentAsin)) {
          row.product_name = titleMap.get(parentAsin);
          continue;
        }

        // Parent ASIN prefix match: find child ASINs that share prefix
        // Amazon parent ASINs often share first ~6 chars with children
        const prefix = parentAsin.slice(0, 6);
        for (const [childAsin, title] of titleMap) {
          if (childAsin.startsWith(prefix)) {
            // Extract product line from title (before variant descriptor)
            const shortTitle = title
              .replace(/\s*-\s*(Unscented|Peppermint|Sweet Orange|Assorted|Vanilla|Lavender|Orange).*$/i, "")
              .replace(/\s*3pk.*$/i, "")
              .replace(/\s*3-Pack.*$/i, "")
              .trim();
            row.product_name = shortTitle || title.split(" - ")[0];
            break;
          }
        }

        // Step 3: Check inventory_restock for more ASIN→title mappings
        if (!row.product_name) {
          try {
            const restock = await sb.from("inventory_restock").select("asin,product_name");
            for (const r of restock.data ?? []) {
              if (r.asin === parentAsin && r.product_name) {
                row.product_name = r.product_name;
                break;
              }
            }
          } catch { /* ok */ }
        }
        // No fake titles — unresolved ASINs show raw code
      }
    }

    return Response.json({ traffic, asinTraffic, reimbursements });
  } catch (e) {
    return Response.json({ traffic: [], asinTraffic: [], reimbursements: [] });
  }
}
