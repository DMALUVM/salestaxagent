import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { isSafeIdent, isWarehouseTable } from "@/lib/warehouse-tables";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/warehouse?table=nexus_status&orderBy=state_code&ascending=true&eq.status=open
 *
 * Service-role read for Tax / Overview / Calendar / Compliance / Registrations
 * (and the remaining useSupabaseQuery tables). Paginated past the PostgREST
 * 1 000-row default. Unknown tables are rejected.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const table = params.get("table") ?? "";
  if (!isWarehouseTable(table)) {
    return Response.json({ error: `Table not allowed: ${table}` }, { status: 400 });
  }

  const orderBy = params.get("orderBy");
  if (orderBy && !isSafeIdent(orderBy)) {
    return Response.json({ error: `Invalid orderBy: ${orderBy}` }, { status: 400 });
  }
  const ascending = params.get("ascending") !== "false";
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit as number) < 1)) {
    return Response.json({ error: `Invalid limit: ${limitRaw}` }, { status: 400 });
  }

  const eqFilters: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (!key.startsWith("eq.")) continue;
    const col = key.slice(3);
    if (!isSafeIdent(col)) {
      return Response.json({ error: `Invalid filter: ${key}` }, { status: 400 });
    }
    eqFilters.push([col, value]);
  }

  try {
    const sb = getServerSupabase();
    const PAGE = 1000;
    const all: Record<string, unknown>[] = [];
    const maxRows = limit && limit <= PAGE ? limit : undefined;
    let offset = 0;

    while (true) {
      const to = maxRows ? maxRows - 1 : offset + PAGE - 1;
      let query = sb.from(table).select("*");
      for (const [col, value] of eqFilters) {
        query = query.eq(col, value);
      }
      if (orderBy) {
        query = query.order(orderBy, { ascending });
      }
      query = query.range(offset, to);

      const { data, error } = await query;
      if (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      const page = data ?? [];
      all.push(...page);
      if (maxRows || page.length < PAGE) break;
      offset += PAGE;
    }

    return Response.json(all);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
