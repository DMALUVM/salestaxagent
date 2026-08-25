import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { ingestAdsMonthlyCsv } from "@/lib/ads-monthly-ingest";
import { isAmazonAdsSpendCsv } from "@/lib/parsers/amazon-ads-spend";
import { parseAmazonInventoryCSV } from "@/lib/parsers/amazon";
import {
  isCustomCombinedTax,
  parseAmazonTaxReportCSV,
} from "@/lib/parsers/amazon-tax-report";

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const reportType = formData.get("type") as string | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: "File too large. Maximum size is 200 MB." },
        { status: 400 },
      );
    }

    // Only Amazon reports supported
    if (
      reportType &&
      !["amazon_inventory", "amazon_tax_report", "amazon"].includes(reportType)
    ) {
      return Response.json(
        { error: `Unsupported report type: ${reportType}` },
        { status: 400 },
      );
    }

    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
      return Response.json({
        error: "Excel SKU Economics files go on the Mini: drop them in incoming/amazon/. Save as CSV to upload here.",
      }, { status: 400 });
    }

    const content = await file.text();

    // Auto-detect: read first line of CSV to determine report type
    const firstLine = content.split(/\r?\n/)[0] ?? "";
    const isTaxReport = isCustomCombinedTax(firstLine);

    if (isAmazonAdsSpendCsv(content)) {
      return handleAdsSpend(content, file.name);
    }
    if (isTaxReport) {
      return handleTaxReport(content, file.name);
    }
    return handleInventoryReport(content, file.name);
  } catch (e) {
    return Response.json(
      {
        error: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
}

async function handleAdsSpend(content: string, filename: string) {
  const sb = getServerSupabase();
  const result = await ingestAdsMonthlyCsv(sb, filename, content);
  if (!result.ok) {
    return Response.json({
      success: false,
      report_type: "amazon_ads_spend",
      filename,
      error: result.error,
      warnings: result.warnings,
      rows_inserted: 0,
    });
  }
  return Response.json({
    success: true,
    report_type: "amazon_ads_spend",
    filename,
    kind: result.kind,
    months: result.months,
    month_starts: result.month_starts,
    total_spend: result.total_spend,
    rows_inserted: result.rows_inserted,
    rows_parsed: result.rows_parsed,
    rows_skipped: result.rows_skipped,
    warnings: result.warnings,
  });
}

// ---------------------------------------------------------------------------
// Inventory Event Detail
// ---------------------------------------------------------------------------

async function handleInventoryReport(content: string, filename: string) {
  const parsed = parseAmazonInventoryCSV(content, filename);

  if (parsed.events.length === 0) {
    return Response.json({
      success: false,
      report_type: "amazon_inventory",
      filename: parsed.filename,
      rows_total: parsed.rows_total,
      rows_parsed: 0,
      rows_skipped: parsed.rows_skipped,
      rows_inserted: 0,
      states_found: [],
      unknown_fcs: parsed.unknown_fcs,
      warnings: parsed.warnings,
    });
  }

  const sb = getServerSupabase();
  const batchSize = 500;
  let totalInserted = 0;

  for (let i = 0; i < parsed.events.length; i += batchSize) {
    const batch = parsed.events.slice(i, i + batchSize).map((e) => ({
      source_file: e.source_file,
      event_date: e.event_date,
      fc_code: e.fc_code,
      state_code: e.state_code,
      asin: e.asin,
      sku: e.sku,
      fnsku: e.fnsku,
      quantity: e.quantity,
      event_type: e.event_type,
      disposition: e.disposition,
    }));

    const { data, error } = await sb
      .from("inventory_events")
      .upsert(batch, {
        onConflict: "source_file,event_date,fc_code,asin,event_type,quantity",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      return Response.json(
        {
          success: false,
          report_type: "amazon_inventory",
          error: `Database error on batch ${Math.floor(i / batchSize) + 1}: ${error.message}`,
          rows_parsed: parsed.rows_parsed,
          rows_inserted: totalInserted,
          warnings: parsed.warnings,
        },
        { status: 500 },
      );
    }

    totalInserted += data?.length ?? batch.length;
  }

  // Log
  await sb.from("ingestion_log").insert({
    filename: parsed.filename,
    file_type: "amazon_inventory",
    rows_total: parsed.rows_total,
    rows_inserted: totalInserted,
    rows_skipped: parsed.rows_skipped,
    warnings: parsed.warnings.length > 0 ? parsed.warnings : null,
    status: parsed.rows_skipped > 0 ? "partial" : "success",
  });

  await sb.from("audit_log").insert({
    action: "ingest_amazon_inventory",
    category: "ingestion",
    details: {
      source: "dashboard_upload",
      states_found: parsed.states_found,
      unknown_fcs: parsed.unknown_fcs,
      rows_total: parsed.rows_total,
      rows_inserted: totalInserted,
    },
    source_file: parsed.filename,
    rows_affected: totalInserted,
  });

  return Response.json({
    success: true,
    report_type: "amazon_inventory",
    filename: parsed.filename,
    rows_total: parsed.rows_total,
    rows_parsed: parsed.rows_parsed,
    rows_skipped: parsed.rows_skipped,
    rows_inserted: totalInserted,
    states_found: parsed.states_found,
    unknown_fcs: parsed.unknown_fcs,
    warnings: parsed.warnings,
  });
}

// ---------------------------------------------------------------------------
// Custom Combined Tax Report
// ---------------------------------------------------------------------------

async function handleTaxReport(content: string, filename: string) {
  const parsed = parseAmazonTaxReportCSV(content, filename);

  if (parsed.sales_records.length === 0 && parsed.ship_from_events.length === 0) {
    return Response.json({
      success: false,
      report_type: "amazon_tax_report",
      filename: parsed.filename,
      rows_total: parsed.rows_total,
      rows_parsed: parsed.rows_parsed,
      rows_skipped: parsed.rows_skipped,
      rows_inserted: 0,
      unique_orders: parsed.unique_orders,
      states_found: parsed.ship_to_states,
      ship_from_states: parsed.ship_from_states,
      warnings: parsed.warnings,
    });
  }

  const sb = getServerSupabase();
  const batchSize = 500;
  let salesInserted = 0;
  let shipFromInserted = 0;

  // Upsert sales_by_state
  for (let i = 0; i < parsed.sales_records.length; i += batchSize) {
    const batch = parsed.sales_records.slice(i, i + batchSize);

    const { data, error } = await sb
      .from("sales_by_state")
      .upsert(batch, {
        onConflict: "state_code,channel,period_start,period_end",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      return Response.json(
        {
          success: false,
          report_type: "amazon_tax_report",
          error: `Database error (sales_by_state batch ${Math.floor(i / batchSize) + 1}): ${error.message}`,
          rows_inserted: salesInserted,
          warnings: parsed.warnings,
        },
        { status: 500 },
      );
    }

    salesInserted += data?.length ?? batch.length;
  }

  // Upsert ship-from inventory events
  for (let i = 0; i < parsed.ship_from_events.length; i += batchSize) {
    const batch = parsed.ship_from_events.slice(i, i + batchSize);

    const { data, error } = await sb
      .from("inventory_events")
      .upsert(batch, {
        onConflict: "source_file,event_date,fc_code,asin,event_type,quantity",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      // Non-fatal: sales data already inserted
      parsed.warnings.push(`Ship-from insert error: ${error.message}`);
    } else {
      shipFromInserted += data?.length ?? batch.length;
    }
  }

  const totalInserted = salesInserted + shipFromInserted;

  // Log
  await sb.from("ingestion_log").insert({
    filename: parsed.filename,
    file_type: "amazon_sales",
    rows_total: parsed.rows_total,
    rows_inserted: totalInserted,
    rows_skipped: parsed.rows_skipped,
    warnings: parsed.warnings.length > 0 ? parsed.warnings : null,
    status: parsed.rows_skipped > 0 ? "partial" : "success",
  });

  await sb.from("audit_log").insert({
    action: "ingest_amazon_tax_report",
    category: "ingestion",
    details: {
      source: "dashboard_upload",
      ship_to_states: parsed.ship_to_states,
      ship_from_states: parsed.ship_from_states,
      unique_orders: parsed.unique_orders,
      total_gross_sales: parsed.total_gross_sales,
      total_tax_collected: parsed.total_tax_collected,
      sales_periods: parsed.sales_records.length,
    },
    source_file: parsed.filename,
    rows_affected: salesInserted,
  });

  return Response.json({
    success: true,
    report_type: "amazon_tax_report",
    filename: parsed.filename,
    rows_total: parsed.rows_total,
    rows_parsed: parsed.rows_parsed,
    rows_skipped: parsed.rows_skipped,
    rows_inserted: salesInserted,
    ship_from_rows_inserted: shipFromInserted,
    unique_orders: parsed.unique_orders,
    states_found: parsed.ship_to_states,
    ship_from_states: parsed.ship_from_states,
    total_gross_sales: parsed.total_gross_sales,
    total_tax_collected: parsed.total_tax_collected,
    warnings: parsed.warnings,
  });
}
