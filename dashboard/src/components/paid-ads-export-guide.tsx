"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { STALE_AFTER_DAYS } from "@/lib/paid-intel/window";
import { CalendarClock, FileSpreadsheet, Info } from "lucide-react";

function StepList({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-4 text-sm leading-relaxed text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function SourceBlock({
  title,
  badge,
  fileHint,
  steps,
  columns,
  notes,
}: {
  title: string;
  badge?: string;
  fileHint: string;
  steps: string[];
  columns: string[];
  notes?: string[];
}) {
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="cursor-pointer list-none px-4 py-3 font-medium text-sm [&::-webkit-details-marker]:hidden">
        <span className="flex flex-wrap items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          {title}
          {badge ? (
            <Badge variant="outline" className="text-[10px] font-normal">
              {badge}
            </Badge>
          ) : null}
          <span className="text-[10px] text-muted-foreground">{fileHint}</span>
        </span>
      </summary>
      <div className="space-y-3 border-t px-4 py-3">
        <StepList items={steps} />
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Columns the parser expects
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{columns.join(" · ")}</p>
        </div>
        {notes?.length ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {notes.map((n) => (
              <li key={n} className="flex gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/**
 * On-page instructions for manual CSV exports feeding /paid-ads.
 * Content mirrors dashboard/src/lib/paid-intel/parse.ts detection rules.
 */
export function PaidAdsExportGuide() {
  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle className="text-sm font-semibold">How to export & upload CSVs</CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          This desk has no live API — upload exports from each platform. Drop files on this page or use{" "}
          <strong>Upload CSVs</strong>. You can upload multiple files at once (GSC zip is fine).
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-start gap-2">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-blue-700 dark:text-blue-300" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-blue-900 dark:text-blue-100">Weekly workflow (last 7 days)</p>
              <p className="text-xs leading-relaxed text-blue-800/90 dark:text-blue-200/90">
                Once a week, export <strong>all four sources</strong> for the{" "}
                <strong>last 7 complete days</strong> (e.g. Mon–Sun). Upload everything together.
                Matching days overwrite; older days stay — so weekly 7-day uploads build 14 / 30 / 90 day
                history over time without re-uploading years of data.
              </p>
              <p className="text-xs leading-relaxed text-blue-800/90 dark:text-blue-200/90">
                Pick the <strong>7D</strong> range above to review the week you just uploaded. The chart
                window is relative to the <strong>newest date in your files</strong>, not today.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">When data is stale</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/90">
            A source is <strong>stale</strong> when its newest row is{" "}
            <strong>{STALE_AFTER_DAYS} or more days behind today</strong>. The amber banner and the{" "}
            <em>What data is loaded</em> table show age per source. Search Console often trails by ~2 days —
            that lag is expected and is accounted for in coverage math. GSC snapshot files (Queries + Pages
            without dates) are replaced on each upload; they do not go stale.
          </p>
        </div>

        <div className="space-y-2">
          <SourceBlock
            title="Google Ads"
            badge="paid campaigns"
            fileHint="Campaign × Day CSV"
            steps={[
              "Open Google Ads → Reports (or Insights and reports → Report editor).",
              "Build a table report: rows = Campaign, segment or column = Day.",
              "Date range: Last 7 days (or Last 14 days occasionally to backfill thin windows).",
              "Include cost, conversion value, clicks, and impressions at campaign level.",
              "Download / Export as CSV. Filename can include “google” for auto-detection.",
            ]}
            columns={[
              "Campaign",
              "Day (or Date)",
              "Cost",
              "Conv. value",
              "Clicks",
              "Impr.",
              "Search lost IS (budget/rank) optional",
            ]}
            notes={[
              "Typed exports with Search_cost / Performance max_cost columns also work.",
              "Do not export account totals only — need one row per campaign per day.",
            ]}
          />

          <SourceBlock
            title="Meta Ads"
            badge="paid campaigns"
            fileHint="Ads Manager export"
            steps={[
              "Open Meta Ads Manager → Campaigns (or Ads Reporting).",
              "Date range: Last 7 days. Breakdown: by day.",
              "Level: Campaign (ad-set exports are OK — we sum rows per campaign-day).",
              "Export / Download report as CSV.",
            ]}
            columns={[
              "Campaign name",
              "Reporting starts",
              "Amount spent (USD)",
              "Purchases conversion value",
              "Impressions",
              "Link clicks",
              "Frequency",
            ]}
            notes={[
              "Use website purchase value columns, not cost-per-purchase.",
              "Filename with “meta” or “tallow” helps detection.",
            ]}
          />

          <SourceBlock
            title="Google Search Console"
            badge="organic search"
            fileHint="Queries.csv + Pages.csv + Chart.csv"
            steps={[
              "Open Google Search Console → Performance → Search results.",
              "Property: your Shopify site (https://tallowbourn.com or www).",
              "Date: Last 7 days (data is usually 2–3 days behind — export through the latest available day).",
              "Export Queries (top queries), Pages (top pages), and the performance Chart (daily trend).",
              "Upload all three CSVs, or the zip bundle if Search Console offers one export.",
            ]}
            columns={[
              "Queries: Top queries, Clicks, Impressions, CTR, Position",
              "Pages: Top pages, Clicks, Impressions…",
              "Chart: date, clicks, impressions, ctr, position",
            ]}
            notes={[
              "Chart.csv drives the daily trend; Queries/Pages are rolling snapshots (no dates).",
              "GSC zip exports are auto-split on upload.",
            ]}
          />

          <SourceBlock
            title="Google Analytics 4"
            badge="site behavior"
            fileHint="Explore → Free form CSV"
            steps={[
              "Open GA4 → Explore → Blank (Free form).",
              "Dimensions: Date, Session default channel group, Landing page, Device category.",
              "Metrics: Sessions, Active users, Key events, Total revenue, Bounce rate.",
              "Date range: Last 7 days (match your ad exports).",
              "Export the exploration as CSV (header comments with # are expected).",
            ]}
            columns={[
              "Date",
              "Session default channel group",
              "Landing page",
              "Device category",
              "Sessions",
              "Key events",
              "Total revenue",
              "Bounce rate",
            ]}
            notes={[
              "Paid channel groups (Paid Search, Paid Social, Cross-network) feed product attribution for PMax.",
              "Filename with “download”, “ga4”, or “explore” helps detection.",
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}
