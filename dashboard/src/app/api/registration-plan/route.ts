import { getServerSupabase } from "@/lib/supabase-server";
import {
  emptyCounts,
  loadRegistrationPlanFromWarehouse,
  warehouseLooksEmpty,
} from "@/lib/registration-plan";

/**
 * GET /api/registration-plan — ranked sales-tax registration plan.
 *
 * Computed in-process from warehouse tables (state_rules, nexus_status,
 * sales_by_state, inventory_events) using the same `decide()` rules as
 * `src/exports/registration_plan.py`. Never shells out to Python — the
 * previous local-Python path fails on Vercel serverless.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const plan = await loadRegistrationPlanFromWarehouse(sb);

    if (warehouseLooksEmpty(plan)) {
      return Response.json({
        available: false,
        rows: [],
        counts: emptyCounts(),
        residual_risk: "",
        source: "warehouse",
        error: "warehouse_empty",
        hint:
          "No state, nexus, sales, or inventory rows in the warehouse yet. "
          + "After the Mini syncs those tables, refresh this card.",
      });
    }

    return Response.json({
      available: true,
      rows: plan.rows,
      counts: plan.counts,
      residual_risk: plan.residual_risk,
      source: plan.source,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 400) : "unknown error";
    return Response.json({
      available: false,
      rows: [],
      counts: emptyCounts(),
      residual_risk: "",
      source: "warehouse",
      error: message,
      hint:
        "Could not read the registration plan from the warehouse. "
        + "Confirm SUPABASE_URL and SUPABASE_SERVICE_KEY on this deploy.",
    });
  }
}
