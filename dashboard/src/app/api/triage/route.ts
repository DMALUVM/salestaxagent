import { getServerSupabase } from "@/lib/supabase-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface PostureEntry {
  posture: string;
  confidence: string;
  citation: string;
  notes: string;
  last_reviewed: string;
}

/**
 * GET /api/triage
 *
 * Returns registration triage data: inventory presence, sales,
 * postures, economic status, entity tax flags — bucketed for CPA review.
 */
export async function GET() {
  const sb = getServerSupabase();

  // Load FBA nexus posture config
  let postures: Record<string, PostureEntry> = {};
  // Try dashboard-local path first (Vercel), then repo root (dev)
  const paths = [
    join(process.cwd(), "content", "fba_nexus_posture.json"),
    join(process.cwd(), "..", "config", "fba_nexus_posture.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        postures = raw.postures ?? {};
      } catch { /* ignore parse errors */ }
      break;
    }
  }

  // Fetch all needed data in parallel
  const [
    { data: nexusRows },
    { data: salesRows },
    { data: flagRows },
  ] = await Promise.all([
    sb.from("nexus_status").select("*"),
    sb.from("sales_by_state").select("state_code, channel, gross_sales, period_end"),
    sb.from("franchise_tax_flags").select("*").eq("status", "open"),
  ]);

  // Inventory presence: try RPC first, fall back to paginated fetch
  const inventoryMap: Record<string, { events: number; min_date: string; max_date: string }> = {};

  const { data: invAgg, error: rpcErr } = await sb.rpc("inventory_state_summary");
  if (!rpcErr && invAgg && Array.isArray(invAgg)) {
    for (const row of invAgg) {
      inventoryMap[row.state_code] = {
        events: row.event_count ?? 0,
        min_date: row.min_date ?? "",
        max_date: row.max_date ?? "",
      };
    }
  } else {
    // Fallback: fetch inventory_events in pages and aggregate
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: batch } = await sb
        .from("inventory_events")
        .select("state_code, event_date")
        .not("state_code", "is", null)
        .range(offset, offset + PAGE - 1);
      if (!batch || batch.length === 0) break;
      for (const e of batch) {
        const sc = e.state_code;
        if (!sc) continue;
        if (!inventoryMap[sc]) {
          inventoryMap[sc] = { events: 0, min_date: "9999-12-31", max_date: "0000-01-01" };
        }
        const m = inventoryMap[sc];
        m.events++;
        const d = e.event_date ?? "";
        if (d && d < m.min_date) m.min_date = d;
        if (d && d > m.max_date) m.max_date = d;
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
  }

  // Build nexus lookup
  const nexusMap: Record<string, Record<string, unknown>> = {};
  for (const n of nexusRows ?? []) {
    nexusMap[n.state_code] = n;
  }

  // Aggregate trailing-12m sales by state + channel
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const salesMap: Record<string, { shopify: number; amazon: number }> = {};
  for (const s of salesRows ?? []) {
    const pe = s.period_end ?? "";
    if (pe < cutoffStr) continue;
    const sc = s.state_code;
    if (!sc) continue;
    if (!salesMap[sc]) salesMap[sc] = { shopify: 0, amazon: 0 };
    const ch = (s.channel ?? "").toLowerCase();
    const amt = Number(s.gross_sales) || 0;
    if (ch.includes("shopify")) salesMap[sc].shopify += amt;
    else salesMap[sc].amazon += amt;
  }

  // Entity tax flags by state
  const flagMap: Record<string, Array<Record<string, unknown>>> = {};
  for (const f of flagRows ?? []) {
    const sc = f.state_code;
    if (!flagMap[sc]) flagMap[sc] = [];
    flagMap[sc].push(f);
  }

  // Union all states
  const allStates = new Set<string>();
  for (const sc of Object.keys(inventoryMap)) allStates.add(sc);
  for (const sc of Object.keys(salesMap)) allStates.add(sc);
  for (const sc of Object.keys(flagMap)) allStates.add(sc);
  for (const sc of Object.keys(nexusMap)) {
    const n = nexusMap[sc];
    if (n.has_physical_nexus || n.has_economic_nexus) allStates.add(sc);
  }

  const WARN_PCT = 80;
  const rows = [];

  for (const sc of [...allStates].sort()) {
    const pd = postures[sc] ?? {};
    const posture = pd.posture ?? "unknown";
    const postureConf = pd.confidence ?? "low";
    const postureCitation = pd.citation ?? "";
    const postureNotes = pd.notes ?? "";

    const inv = inventoryMap[sc];
    const hasInventory = !!inv && inv.events > 0;

    const sale = salesMap[sc] ?? { shopify: 0, amazon: 0 };
    const nx = nexusMap[sc] ?? {};
    const flags = flagMap[sc] ?? [];

    const econExceeded = !!nx.has_economic_nexus;
    const econPct = Number(nx.economic_progress_percent) || 0;
    const econApproaching = econPct >= WARN_PCT && !econExceeded;
    const isRegistered = !!nx.is_registered;
    const hasEntityFlags = flags.length > 0;

    // Triage bucket
    let triage = "B_monitor";
    if ((posture === "asserts" || posture === "contested") && (sale.shopify > 0 || hasEntityFlags)) {
      triage = "A_discuss";
    } else if (hasEntityFlags) {
      triage = "D_entity_tax";
    } else if (econApproaching || econExceeded) {
      triage = "C_economic_watch";
    } else if (posture === "carve_out" && sale.shopify < 1000 && !econExceeded) {
      triage = "B_monitor";
    } else if ((posture === "asserts" || posture === "contested") && hasInventory) {
      triage = "A_discuss";
    }

    if (isRegistered) triage = "B_monitor";

    rows.push({
      state_code: sc,
      has_inventory: hasInventory,
      inventory_first: inv?.min_date ?? null,
      inventory_last: inv?.max_date ?? null,
      inventory_events: inv?.events ?? 0,
      posture,
      posture_confidence: postureConf,
      posture_citation: postureCitation,
      posture_notes: postureNotes,
      shopify_sales_12m: Math.round(sale.shopify * 100) / 100,
      amazon_sales_12m: Math.round(sale.amazon * 100) / 100,
      economic_nexus_status: econExceeded ? "exceeded" : econApproaching ? "approaching" : "under",
      economic_progress_pct: Math.round(econPct * 10) / 10,
      is_registered: isRegistered,
      has_entity_tax_flag: hasEntityFlags,
      entity_flags: flags.map((f) => ({
        type: f.flag_type,
        severity: f.severity,
        description: f.description,
      })),
      triage_bucket: triage,
    });
  }

  return Response.json({ rows, generated: new Date().toISOString() });
}
