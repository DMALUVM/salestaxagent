import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  dedupeCampaigns, dedupeGa, dedupeQueries, mergeParsed,
  parseNamedFile, parseZipBuffer, type CampaignDaily, type GaDaily,
  type ParsedFiles, type SearchQueryDaily,
} from "@/lib/paid-intel";

export const runtime = "nodejs";
export const maxDuration = 60;

const CAMP_BATCH = 400;
const Q_BATCH = 400;
const GA_BATCH = 400;

function toCampRow(r: CampaignDaily, ingestedAt: string) {
  return {
    platform: r.platform,
    date: r.date,
    campaign_name: r.campaign_name,
    campaign_type: r.campaign_type,
    product: r.product,
    is_brand: r.is_brand,
    audience: r.audience,
    spend: r.spend,
    conv_value: r.conv_value,
    clicks: r.clicks,
    impressions: r.impressions,
    conversions: r.conversions,
    lost_is_budget: r.lost_is_budget,
    lost_is_rank: r.lost_is_rank,
    frequency: r.frequency,
    status: r.status,
    ingested_at: ingestedAt,
  };
}

function toQueryRow(r: SearchQueryDaily, ingestedAt: string) {
  return {
    kind: r.kind,
    date: r.date ?? "",
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
    ingested_at: ingestedAt,
  };
}

function toGaRow(r: GaDaily, ingestedAt: string) {
  return {
    date: r.date,
    channel_group: r.channel_group,
    landing_page: r.landing_page,
    device: r.device,
    sessions: r.sessions,
    active_users: r.active_users,
    key_events: r.key_events,
    revenue: r.revenue,
    bounce_rate: r.bounce_rate,
    ingested_at: ingestedAt,
  };
}

async function upsertChunks(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<string | null> {
  if (!rows.length) return null;
  const sb = getServerSupabase();
  const size = table === "paid_ga_daily" ? GA_BATCH
    : table === "paid_search_query_daily" ? Q_BATCH
    : CAMP_BATCH;
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) return `${table}: ${error.message}`;
  }
  return null;
}

async function parseRequest(request: NextRequest): Promise<ParsedFiles> {
  const ct = request.headers.get("content-type") ?? "";
  const parts: ParsedFiles[] = [];
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") continue;
      const file = value as File;
      const name = file.name || key;
      const buf = Buffer.from(await file.arrayBuffer());
      if (name.toLowerCase().endsWith(".zip") || file.type === "application/zip") {
        parts.push(parseZipBuffer(name, buf));
      } else {
        parts.push(parseNamedFile(name, buf.toString("utf8")));
      }
    }
    return mergeParsed(parts);
  }
  const body = await request.json().catch(() => null);
  const files = body && typeof body === "object" && Array.isArray((body as { files?: unknown }).files)
    ? (body as { files: Array<{ name?: string; content?: string; base64?: string }> }).files
    : [];
  for (const f of files) {
    const name = f.name || "upload.csv";
    if (f.base64 && name.toLowerCase().endsWith(".zip")) {
      parts.push(parseZipBuffer(name, Buffer.from(f.base64, "base64")));
    } else if (typeof f.content === "string") {
      parts.push(parseNamedFile(name, f.content));
    }
  }
  return mergeParsed(parts);
}

/**
 * POST /api/paid-ads/csv
 * Upsert Google / Meta / GSC / GA4 CSVs. Matching days overwrite; older days stay.
 * Empty-date GSC snapshots replace other empty-date rows of the same kind only.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequest(request);
    const campaigns = dedupeCampaigns(parsed.campaigns);
    const queries = dedupeQueries(parsed.queries);
    const ga = dedupeGa(parsed.ga);
    if (!campaigns.length && !queries.length && !ga.length) {
      return Response.json({
        ok: false,
        error: parsed.warnings[0] || "No recognisable Google, Meta, GSC, or GA4 rows",
        skipped: parsed.skipped,
        warnings: parsed.warnings,
      }, { status: 400 });
    }

    const ingestedAt = new Date().toISOString();
    const sb = getServerSupabase();

    const snapshotKinds = new Set(
      queries.filter((q) => q.date === "" && (q.kind === "query" || q.kind === "page")).map((q) => q.kind),
    );
    for (const kind of snapshotKinds) {
      const { error } = await sb
        .from("paid_search_query_daily")
        .delete()
        .eq("kind", kind)
        .eq("date", "");
      if (error && !/does not exist|PGRST205/i.test(error.message)) {
        return Response.json({ ok: false, error: `snapshot replace: ${error.message}` }, { status: 500 });
      }
    }

    const campErr = await upsertChunks(
      "paid_campaign_daily",
      campaigns.map((r) => toCampRow(r, ingestedAt)),
      "platform,date,campaign_name",
    );
    if (campErr) return Response.json({ ok: false, error: campErr }, { status: 500 });

    const qErr = await upsertChunks(
      "paid_search_query_daily",
      queries.map((r) => toQueryRow(r, ingestedAt)),
      "kind,date,query",
    );
    if (qErr) return Response.json({ ok: false, error: qErr }, { status: 500 });

    const gaErr = await upsertChunks(
      "paid_ga_daily",
      ga.map((r) => toGaRow(r, ingestedAt)),
      "date,channel_group,landing_page,device",
    );
    if (gaErr) return Response.json({ ok: false, error: gaErr }, { status: 500 });

    const maxOf = (rows: Array<{ date: string }>) => {
      const dated = rows.map((r) => r.date).filter(Boolean).sort();
      return dated[dated.length - 1] ?? null;
    };

    return Response.json({
      ok: true,
      sources: parsed.sources,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      /** Per-file receipt: what was recognised, how many rows, and the date span. */
      accepted: parsed.accepted,
      files_received: parsed.accepted.length + parsed.skipped.length,
      upserted: {
        campaigns: campaigns.length,
        queries: queries.length,
        ga: ga.length,
      },
      newest: {
        paid: maxOf(campaigns),
        gsc: maxOf(queries.filter((q) => q.date)),
        ga4: maxOf(ga),
      },
      ingested_at: ingestedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
