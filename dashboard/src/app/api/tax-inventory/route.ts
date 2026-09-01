import { getServerSupabase } from "@/lib/supabase-server";
import {
  AWD_NATIONAL_NOTE,
  attachAwdNational,
  peakByState,
  toCsv,
  type LedgerDailyRow,
  type StatePeak,
  type TaxInventoryPayload,
} from "@/lib/tax-inventory";

export const dynamic = "force-dynamic";

const PAGE = 1000;

async function fetchAll<T>(
  query: (
    from: number,
    to: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await query(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function yearBounds(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

async function loadPeaksFromTable(
  sb: ReturnType<typeof getServerSupabase>,
  year: number,
): Promise<StatePeak[]> {
  const { start, end } = yearBounds(year);
  const rows = await fetchAll<LedgerDailyRow>(async (from, to) => {
    const r = await sb
      .from("inventory_ledger_summary_daily")
      .select(
        "snapshot_date,sku,fc_code,state_code,disposition,ending_qty,cogs_per_unit,cogs_value",
      )
      .gte("snapshot_date", start)
      .lte("snapshot_date", end)
      .range(from, to);
    return { data: (r.data ?? null) as LedgerDailyRow[] | null, error: r.error };
  });
  return peakByState(rows, year);
}

async function loadAwdNational(
  sb: ReturnType<typeof getServerSupabase>,
): Promise<{ cogs: number; units: number; missingUnits: number }> {
  const [awdRows, costRows] = await Promise.all([
    fetchAll<{ sku: string; awd_on_hand: number }>(async (from, to) => {
      const r = await sb.from("inventory_awd").select("sku,awd_on_hand").range(from, to);
      return {
        data: (r.data ?? null) as { sku: string; awd_on_hand: number }[] | null,
        error: r.error,
      };
    }),
    fetchAll<{ sku: string; cogs_per_unit: number | null }>(async (from, to) => {
      const r = await sb.from("sku_costs").select("sku,cogs_per_unit").range(from, to);
      return {
        data: (r.data ?? null) as { sku: string; cogs_per_unit: number | null }[] | null,
        error: r.error,
      };
    }),
  ]);

  const costs = new Map<string, number>();
  for (const r of costRows) {
    const sku = (r.sku ?? "").trim().toUpperCase();
    if (!sku || r.cogs_per_unit == null) continue;
    costs.set(sku, Number(r.cogs_per_unit));
  }

  let cogs = 0;
  let units = 0;
  let missingUnits = 0;
  for (const r of awdRows) {
    const qty = Number(r.awd_on_hand) || 0;
    if (qty === 0) continue;
    units += qty;
    const unitCost = costs.get((r.sku ?? "").trim().toUpperCase());
    if (unitCost == null) missingUnits += qty;
    else cogs += qty * unitCost;
  }
  return { cogs, units, missingUnits };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year") || "2026");
  const format = url.searchParams.get("format");
  if (!Number.isFinite(year) || year < 2020 || year > 2100) {
    return Response.json({ error: "Invalid year" }, { status: 400 });
  }

  try {
    const sb = getServerSupabase();
    const { start, end } = yearBounds(year);

    let states: StatePeak[] = [];
    const { data: rpcRows, error: rpcErr } = await sb.rpc(
      "tax_inventory_state_peaks",
      { p_year: year },
    );
    if (!rpcErr && rpcRows) {
      states = (rpcRows as StatePeak[]).map((r) => ({
        ...r,
        peak_cogs: Number(r.peak_cogs) || 0,
        current_cogs: Number(r.current_cogs) || 0,
        current_units: Number(r.current_units) || 0,
        current_fc_count: Number(r.current_fc_count) || 0,
        fba_cogs: Number(r.current_cogs) || 0,
        awd_cogs: 0,
      }));
    } else {
      states = await loadPeaksFromTable(sb, year);
    }

    const [awd, missing, unknownFcs, latestRow] = await Promise.all([
      loadAwdNational(sb),
      sb
        .from("inventory_ledger_summary_daily")
        .select("sku,ending_qty")
        .gte("snapshot_date", start)
        .lte("snapshot_date", end)
        .is("cogs_per_unit", null)
        .then((r) => r.data ?? []),
      sb
        .from("inventory_ledger_summary_daily")
        .select("fc_code")
        .gte("snapshot_date", start)
        .lte("snapshot_date", end)
        .is("state_code", null)
        .then((r) => r.data ?? []),
      sb
        .from("inventory_ledger_summary_daily")
        .select("snapshot_date")
        .gte("snapshot_date", start)
        .lte("snapshot_date", end)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .then((r) => r.data?.[0]?.snapshot_date ?? null),
    ]);

    const missingSkus = new Set<string>();
    let missingUnits = 0;
    for (const r of missing as { sku: string; ending_qty: number }[]) {
      missingSkus.add(r.sku);
      missingUnits += Math.abs(Number(r.ending_qty) || 0);
    }

    const unknown = [
      ...new Set(
        (unknownFcs as { fc_code: string }[]).map((r) => r.fc_code).filter(Boolean),
      ),
    ].sort();

    const withAwd = attachAwdNational(states, awd.cogs, awd.units).sort(
      (a, b) => b.peak_cogs - a.peak_cogs || b.current_cogs - a.current_cogs,
    );

    const payload: TaxInventoryPayload = {
      year,
      latest_snapshot: latestRow ? String(latestRow).slice(0, 10) : null,
      states: withAwd,
      awd: {
        cogs: Math.round(awd.cogs * 100) / 100,
        units: awd.units,
        note: AWD_NATIONAL_NOTE,
      },
      unknown_fcs: unknown,
      missing_cost: {
        sku_count: missingSkus.size,
        units: missingUnits + awd.missingUnits,
      },
    };

    if (format === "csv") {
      return new Response(toCsv(withAwd), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="tax-inventory-${year}.csv"`,
        },
      });
    }

    return Response.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}
