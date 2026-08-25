import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdsSpendParseResult } from "@/lib/parsers/amazon-ads-spend";
import { parseAmazonAdsSpendCsv } from "@/lib/parsers/amazon-ads-spend";

export interface AdsMonthlyPersistResult {
  ok: boolean;
  filename: string;
  kind: string | null;
  months: number;
  month_starts: string[];
  total_spend: number;
  rows_inserted: number;
  rows_parsed: number;
  rows_skipped: number;
  warnings: string[];
  error?: string;
}

export async function persistAdsMonthlyParse(
  sb: SupabaseClient,
  parsed: AdsSpendParseResult,
  filename: string,
): Promise<AdsMonthlyPersistResult> {
  const base = {
    filename,
    kind: parsed.kind,
    months: parsed.months.length,
    month_starts: parsed.months.map((m) => m.period_start),
    total_spend: parsed.months.reduce((s, m) => s + m.spend, 0),
    rows_parsed: parsed.rows_parsed,
    rows_skipped: parsed.rows_skipped,
    warnings: [...parsed.warnings],
    rows_inserted: 0,
    ok: false,
  };

  if (!parsed.kind || (!parsed.months.length && !parsed.daily.length)) {
    return {
      ...base,
      error: parsed.warnings[0] ?? "Not a SKU Economics or Ads Console campaign report.",
    };
  }

  let inserted = 0;
  if (parsed.months.length) {
    const { data, error } = await sb
      .from("ads_monthly_spend")
      .upsert(
        parsed.months.map((m) => ({ ...m, filename })),
        { onConflict: "period_start" },
      )
      .select("period_start");
    if (error) {
      return { ...base, error: `ads_monthly_spend: ${error.message}` };
    }
    inserted += data?.length ?? parsed.months.length;
  }

  if (parsed.daily.length) {
    const { data, error } = await sb
      .from("ads_campaigns_daily")
      .upsert(parsed.daily, { onConflict: "date,campaign_id" })
      .select("campaign_id");
    if (error) {
      base.warnings.push(`ads_campaigns_daily: ${error.message}`);
    } else {
      inserted += data?.length ?? parsed.daily.length;
    }
  }

  await sb.from("ingestion_log").insert({
    filename,
    file_type: "amazon_ads",
    rows_total: parsed.rows_total,
    rows_inserted: inserted,
    rows_skipped: parsed.rows_skipped,
    warnings: base.warnings.length ? base.warnings : null,
    status: base.warnings.length ? "partial" : "success",
  });

  await sb.from("audit_log").insert({
    action: "ingest_amazon_ads_spend",
    category: "ingestion",
    details: {
      source: "dashboard_upload",
      filename,
      kind: parsed.kind,
      months: base.month_starts,
      spend: base.total_spend,
    },
    source_file: filename,
    rows_affected: inserted,
  });

  return { ...base, rows_inserted: inserted, ok: true };
}

export async function ingestAdsMonthlyCsv(
  sb: SupabaseClient,
  filename: string,
  content: string,
): Promise<AdsMonthlyPersistResult> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    return {
      ok: false,
      filename,
      kind: null,
      months: 0,
      month_starts: [],
      total_spend: 0,
      rows_inserted: 0,
      rows_parsed: 0,
      rows_skipped: 0,
      warnings: [],
      error: "Excel files are not supported in the browser. Export CSV from Seller Central.",
    };
  }
  const parsed = parseAmazonAdsSpendCsv(content);
  return persistAdsMonthlyParse(sb, parsed, filename);
}
