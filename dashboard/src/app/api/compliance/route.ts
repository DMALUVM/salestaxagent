import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { AMAZON, SHOPIFY, SHOPIFY_SHOP, SHOPIFY_SUB, isQuarantinedSource, normalizeChannel } from "@/lib/channels";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * GET /api/compliance?state=CA
 *
 * Returns the compliance playbook config + live Supabase context.
 * Playbook JSON files live in dashboard/content/compliance_playbooks/
 * so they deploy with the Next.js app on Vercel.
 */
export async function GET(request: NextRequest) {
  const state = (request.nextUrl.searchParams.get("state") ?? "").toUpperCase();
  if (!state || state.length !== 2) {
    return Response.json(
      { error: "Missing or invalid state code" },
      { status: 400 },
    );
  }

  // Load playbook JSON from dashboard-local content directory
  const dir = join(process.cwd(), "content", "compliance_playbooks");
  let config: Record<string, unknown> = {};
  let playbookFound = false;

  const specific = join(dir, `${state}.json`);
  const generic = join(dir, "_GENERIC.json");

  try {
    if (existsSync(specific)) {
      config = JSON.parse(readFileSync(specific, "utf-8"));
      playbookFound = true;
    } else if (existsSync(generic)) {
      let raw = readFileSync(generic, "utf-8");
      // Substitute state name from Supabase
      const sbInit = getServerSupabase();
      const { data: rules } = await sbInit
        .from("state_rules")
        .select("state_name")
        .eq("state_code", state)
        .limit(1);
      const name = rules?.[0]?.state_name ?? state;
      raw = raw.replace(/\{state_name\}/g, name).replace(/_GENERIC/g, state);
      config = JSON.parse(raw);
      (config as Record<string, unknown>).state_name = name;
      (config as Record<string, unknown>).state_code = state;
      playbookFound = true;
    }
  } catch (e) {
    // File read error — fall through with empty config
  }

  // Load live context from Supabase
  const sb = getServerSupabase();

  const { data: nexus } = await sb
    .from("nexus_status")
    .select("*")
    .eq("state_code", state)
    .limit(1);
  const { data: flags } = await sb
    .from("franchise_tax_flags")
    .select("*")
    .eq("state_code", state)
    .eq("status", "open");
  const { data: filings } = await sb
    .from("filing_calendar")
    .select("*")
    .eq("state_code", state)
    .order("due_date", { ascending: true });

  // Sales totals
  const { data: sales } = await sb
    .from("sales_by_state")
    .select("channel, gross_sales, source")
    .eq("state_code", state);
  let shopify = 0;
  let amazon = 0;
  for (const s of sales ?? []) {
    if (isQuarantinedSource(s.source)) continue;
    const ch = normalizeChannel(s.channel ?? "");
    const amt = Number(s.gross_sales) || 0;
    if (ch === SHOPIFY || ch === SHOPIFY_SHOP || ch === SHOPIFY_SUB) shopify += amt;
    else if (ch === AMAZON) amazon += amt;
  }

  return Response.json({
    config,
    playbook_found: playbookFound,
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
