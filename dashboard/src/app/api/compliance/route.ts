import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * GET /api/compliance?state=CA
 *
 * Returns the compliance playbook config for a state,
 * merged with live nexus/sales context from Supabase.
 */
export async function GET(request: NextRequest) {
  const state = (request.nextUrl.searchParams.get("state") ?? "").toUpperCase();
  if (!state || state.length !== 2) {
    return Response.json({ error: "Missing or invalid state code" }, { status: 400 });
  }

  // Load playbook config (file-based)
  const dir = join(process.cwd(), "..", "config", "compliance_playbooks");
  let config: Record<string, unknown> = {};

  const specific = join(dir, `${state}.json`);
  const generic = join(dir, "_GENERIC.json");

  if (existsSync(specific)) {
    config = JSON.parse(readFileSync(specific, "utf-8"));
  } else if (existsSync(generic)) {
    let raw = readFileSync(generic, "utf-8");
    // Substitute state name
    const sb = getServerSupabase();
    const { data: rules } = await sb.from("state_rules").select("state_name").eq("state_code", state).limit(1);
    const name = rules?.[0]?.state_name ?? state;
    raw = raw.replace(/\{state_name\}/g, name).replace(/_GENERIC/g, state);
    config = JSON.parse(raw);
  }

  // Load live context
  const sb = getServerSupabase();

  const { data: nexus } = await sb.from("nexus_status").select("*").eq("state_code", state).limit(1);
  const { data: flags } = await sb.from("franchise_tax_flags").select("*").eq("state_code", state).eq("status", "open");
  const { data: filings } = await sb.from("filing_calendar").select("*").eq("state_code", state).order("due_date", { ascending: true });

  // Sales totals (aggregate from sales_by_state)
  const { data: sales } = await sb.from("sales_by_state").select("channel, gross_sales").eq("state_code", state);
  let shopify = 0, amazon = 0;
  for (const s of sales ?? []) {
    const ch = (s.channel ?? "").toLowerCase();
    const amt = Number(s.gross_sales) || 0;
    if (ch === "shopify") shopify += amt;
    else if (ch === "amazon") amazon += amt;
  }

  return Response.json({
    config,
    context: {
      nexus: nexus?.[0] ?? null,
      franchise_flags: flags ?? [],
      filings: filings ?? [],
      shopify_total: Math.round(shopify * 100) / 100,
      amazon_total: Math.round(amazon * 100) / 100,
      total_sales: Math.round((shopify + amazon) * 100) / 100,
    },
  });
}
