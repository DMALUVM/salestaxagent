"use client";

import { useEffect, useMemo, useState, Fragment, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  buildPnlPeriods,
  coverageLabel,
  grainLabel,
  lookbackLabel,
  summarizePeriods,
  type PnlGrain,
  type PnlLookback,
  type PnlPeriod,
  type PnlRow,
  PNL_GRAINS,
  PNL_LOOKBACKS,
} from "@/lib/pnl-periods";
import type { MonthlySkuLine } from "@/lib/sku-monthly-pnl";
import { windowStart } from "@/lib/as-of";
import { ChevronRight } from "lucide-react";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function moneyClass(n: number | null): string {
  if (n == null) return "text-muted-foreground";
  return n >= 0 ? "text-emerald-600" : "text-red-500";
}

function Seg<T extends string | number>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase text-muted-foreground">{label}</span>
      <div className="flex gap-1 rounded-md border p-0.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              value === o.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function feesBadge(basis: string, open: boolean, adsBasis?: string) {
  if (open) {
    return (
      <Badge variant="outline" className="text-[9px] bg-muted text-muted-foreground">
        preliminary · excluded
      </Badge>
    );
  }
  const tone =
    basis === "settled"
      ? "bg-emerald-50 text-emerald-700"
      : basis === "mixed"
        ? "bg-sky-50 text-sky-700"
        : "bg-amber-50 text-amber-700";
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant="outline" className={`text-[9px] ${tone}`}>
        {basis}
      </Badge>
      {adsBasis === "unknown" && (
        <Badge variant="outline" className="text-[9px] bg-slate-50 text-slate-600">
          ads unknown
        </Badge>
      )}
      {adsBasis === "mixed" && (
        <Badge variant="outline" className="text-[9px] bg-slate-50 text-slate-600">
          ads mixed
        </Badge>
      )}
    </span>
  );
}

function toggleKey(e: KeyboardEvent, run: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    run();
  }
}

export function PnlTable({
  rows,
  monthly = [],
  monthlySkus = {},
  asOf,
  skuCoverageMin = null,
  skuCoverageMax = null,
  skuMissingJan2024 = false,
  adsDateMin = null,
}: {
  rows: PnlRow[];
  monthly?: PnlRow[];
  monthlySkus?: Record<string, MonthlySkuLine[]>;
  asOf: string | null;
  skuCoverageMin?: string | null;
  skuCoverageMax?: string | null;
  skuMissingJan2024?: boolean;
  adsDateMin?: string | null;
}) {
  const [grain, setGrain] = useState<PnlGrain>(monthly.length ? "month" : "day");
  const [lookback, setLookback] = useState<PnlLookback>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const periods = useMemo(
    () => buildPnlPeriods({ rows, monthly, grain, lookback, asOf }),
    [rows, monthly, grain, lookback, asOf],
  );
  const summary = useMemo(() => summarizePeriods(periods), [periods]);

  const usingMonthly = (grain === "month" || grain === "year") && monthly.length > 0;
  const storedMin = usingMonthly
    ? (skuCoverageMin ?? monthly.reduce<string | null>((m, r) => (!m || r.date < m ? r.date : m), null))
    : rows.reduce<string | null>((m, r) => (!m || r.date < m ? r.date : m), null);
  const storedMax = usingMonthly
    ? (skuCoverageMax ?? monthly.reduce<string | null>((m, r) => (!m || r.date > m ? r.date : m), null))
    : rows.reduce<string | null>((m, r) => (!m || r.date > m ? r.date : m), null);
  const lookbackFloor = lookback === "all" || !asOf ? null : windowStart(asOf, lookback);
  const historyShorterThanLookback = Boolean(
    lookbackFloor && storedMin && storedMin > lookbackFloor,
  );

  function changeGrain(next: PnlGrain) {
    setGrain(next);
    setExpandedKey(null);
    setExpandedDay(null);
  }
  function changeLookback(next: PnlLookback) {
    setLookback(next);
    setExpandedKey(null);
    setExpandedDay(null);
  }
  function togglePeriod(key: string) {
    setExpandedKey((cur) => (cur === key ? null : key));
    setExpandedDay(null);
  }

  const title = grain === "day" ? "Daily P&L" : `${grainLabel(grain)}ly P&L`;
  const lookbackHint = usingMonthly
    ? (lookback === "all"
      ? `all ${monthly.length} Amazon SKU months`
      : `SKU months overlapping the last ${lookback} days ending ${asOf ?? "as-of"}`)
    : lookback === "all"
      ? `all ${rows.length} stored days`
      : `last ${lookback} days ending ${asOf ?? "as-of"}`;

  return (
    <Card id="daily" className="scroll-mt-14">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {usingMonthly
                ? `${summary.periods} ${grain}${summary.periods === 1 ? "" : "s"} · ${summary.days} calendar day${summary.days === 1 ? "" : "s"}`
                : `${summary.days} closed day${summary.days === 1 ? "" : "s"}`}
              {lookback !== "all" && ` in the ${lookback}d window`}
              {summary.avgDaily != null && (
                <>
                  {" · "}
                  <span className={`tabular-nums font-medium ${moneyClass(summary.avgDaily)}`}>
                    ${fmtD(summary.avgDaily)}
                  </span>
                  {" avg / day"}
                  {" · "}
                  <span className={`tabular-nums ${moneyClass(summary.contribution)}`}>
                    ${fmtD(summary.contribution)}
                  </span>
                  {" total"}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Seg
              label="Grain"
              value={grain}
              onChange={changeGrain}
              options={PNL_GRAINS.map((g) => ({ value: g, label: grainLabel(g) }))}
            />
            <Seg
              label="Look back"
              value={lookback}
              onChange={changeLookback}
              options={PNL_LOOKBACKS.map((d) => ({ value: d, label: lookbackLabel(d) }))}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {usingMonthly ? (
            <>
              Amazon SKU economics {storedMin ?? "—"} → {storedMax ?? "—"}
              ({monthly.length} month{monthly.length === 1 ? "" : "s"} from <code>sales_by_sku</code>).
              Showing {lookbackHint}. Average is contribution ÷ calendar days in the visible months.
              Fees are estimated (15% referral + $3.50 FBA / unit). COGS is units × <code>sku_costs</code>.
              {adsDateMin
                ? ` Ad spend is known from ${adsDateMin}; earlier months are labelled ads unknown, not $0.`
                : " Ad spend is unknown on these months."}
              {skuMissingJan2024 && (
                <> Jan–Jul 2024 are not in the warehouse — SP-API keeps ~2 years. Drop a Seller Central All Orders report for those months into <code>incoming/amazon/</code>.</>
              )}
            </>
          ) : (
            <>
              Stored {storedMin ?? "—"} → {storedMax ?? "—"} ({rows.length} Amazon day{rows.length === 1 ? "" : "s"}).
              Showing {lookbackHint}. Average is contribution ÷ days with a stored row — missing days are not filled with $0.
              Weeks are Sunday–Saturday on the Amazon calendar (America/Los_Angeles).
              {historyShorterThanLookback && (
                <> P&amp;L rows start {storedMin} — older days were never synced, so this {lookback}d window is partial.</>
              )}
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{grain === "day" ? "Date" : grainLabel(grain)}</TableHead>
              <TableHead className="text-right">Days</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Fees</TableHead>
              <TableHead className="text-right">Ads</TableHead>
              <TableHead className="text-right">COGS</TableHead>
              <TableHead className="text-right font-semibold">Contribution</TableHead>
              <TableHead className="text-right font-semibold">Avg / day</TableHead>
              <TableHead>Fees basis</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                  {usingMonthly
                    ? "No Amazon SKU months in this lookback."
                    : "No stored P&L days in this lookback. Nightly sync keeps 90 days; Month/Year use SKU economics from Aug 2024."}
                </TableCell>
              </TableRow>
            )}
            {periods.map((p) => {
              const open = expandedKey === p.key;
              return (
                <Fragment key={p.key}>
                  <TableRow
                    className={`cursor-pointer ${p.open ? "opacity-60" : ""}`}
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => togglePeriod(p.key)}
                    onKeyDown={(e) => toggleKey(e, () => togglePeriod(p.key))}
                  >
                    <TableCell className="text-xs tabular-nums">
                      <span className="flex items-center gap-1.5">
                        <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                        <span>
                          {p.label}
                          {p.partial && !p.open && (
                            <span className="ml-1.5 font-normal text-muted-foreground">{coverageLabel(p)}</span>
                          )}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {p.open ? "—" : p.days}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">${fmtD(p.sales)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(p.units)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(p.fees)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {p.adsBasis === "unknown" ? "—" : `$${fmtD(p.ads)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">${fmtD(p.cogs)}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${moneyClass(p.contribution)}`}>
                      ${fmtD(p.contribution)}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${moneyClass(p.avgDaily)}`}>
                      {p.avgDaily == null ? "—" : `$${fmtD(p.avgDaily)}`}
                    </TableCell>
                    <TableCell>{feesBadge(p.feesBasis, p.open, p.adsBasis)}</TableCell>
                  </TableRow>
                  {open && (
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={10} className="py-3">
                        {grain === "day" ? (
                          <DayDetail date={p.start} row={p.rows[0] ?? p.openRows[0]} />
                        ) : p.source === "sku_monthly" ? (
                          <MonthSkuDetail
                            period={p}
                            lines={mergeSkuLines(p, monthlySkus)}
                            dailyRows={rows.filter((r) => r.date >= p.start && r.date <= p.end)}
                            asOf={asOf}
                            expandedDay={expandedDay}
                            onToggleDay={(d) => setExpandedDay((cur) => (cur === d ? null : d))}
                          />
                        ) : (
                          <PeriodDays
                            period={p}
                            asOf={asOf}
                            expandedDay={expandedDay}
                            onToggleDay={(d) => setExpandedDay((cur) => (cur === d ? null : d))}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
          {summary.days > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell className="text-xs">
                  Visible {grain === "day" ? "days" : `${grain}s`}
                </TableCell>
                <TableCell className="text-right tabular-nums">{summary.days}</TableCell>
                <TableCell className="text-right tabular-nums">${fmtD(summary.sales)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(summary.units)}</TableCell>
                <TableCell className="text-right tabular-nums">${fmtD(summary.fees)}</TableCell>
                <TableCell className="text-right tabular-nums">${fmtD(summary.ads)}</TableCell>
                <TableCell className="text-right tabular-nums">${fmtD(summary.cogs)}</TableCell>
                <TableCell className={`text-right tabular-nums font-semibold ${moneyClass(summary.contribution)}`}>
                  ${fmtD(summary.contribution)}
                </TableCell>
                <TableCell className={`text-right tabular-nums font-semibold ${moneyClass(summary.avgDaily)}`}>
                  {summary.avgDaily == null ? "—" : `$${fmtD(summary.avgDaily)}`}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">avg / closed day</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}

function mergeSkuLines(period: PnlPeriod, monthlySkus: Record<string, MonthlySkuLine[]>): MonthlySkuLine[] {
  if (period.grain === "month") {
    return [...(monthlySkus[period.key] ?? monthlySkus[period.start.slice(0, 7)] ?? [])]
      .sort((a, b) => b.est_contribution - a.est_contribution);
  }
  const bySku = new Map<string, MonthlySkuLine>();
  for (const row of period.rows) {
    const ym = row.date.slice(0, 7);
    for (const line of monthlySkus[ym] ?? []) {
      const acc = bySku.get(line.sku);
      if (!acc) {
        bySku.set(line.sku, { ...line });
        continue;
      }
      acc.units += line.units;
      acc.gross_sales += line.gross_sales;
      acc.est_referral_fees += line.est_referral_fees;
      acc.est_fba_fees += line.est_fba_fees;
      acc.est_cogs += line.est_cogs;
      acc.est_contribution += line.est_contribution;
    }
  }
  return [...bySku.values()].sort((a, b) => b.est_contribution - a.est_contribution);
}

function MonthSkuDetail({
  period,
  lines,
  dailyRows,
  asOf,
  expandedDay,
  onToggleDay,
}: {
  period: PnlPeriod;
  lines: MonthlySkuLine[];
  dailyRows: PnlRow[];
  asOf: string | null;
  expandedDay: string | null;
  onToggleDay: (date: string) => void;
}) {
  const skuLines = lines.length
    ? [...lines].sort((a, b) => b.est_contribution - a.est_contribution)
    : [];
  const top = skuLines.slice(0, 12);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {period.label}: Amazon SKU economics
        {period.adsBasis === "unknown" && " · contribution is before ads"}
        {period.avgDaily != null && (
          <>
            {" · "}
            <span className={`tabular-nums font-medium ${moneyClass(period.avgDaily)}`}>
              ${fmtD(period.avgDaily)}
            </span>
            {" avg / calendar day"}
          </>
        )}
        . Ad spend is account-level and is not allocated to a SKU.
      </p>
      {period.grain === "year" && period.rows.length > 1 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pb-1 text-left font-medium">Month</th>
                <th className="pb-1 text-right font-medium">Sales</th>
                <th className="pb-1 text-right font-medium">Ads</th>
                <th className="pb-1 text-right font-medium">COGS</th>
                <th className="pb-1 text-right font-medium">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {period.rows.map((r) => (
                <tr key={r.date}>
                  <td className="py-1 tabular-nums">{r.date.slice(0, 7)}</td>
                  <td className="py-1 text-right tabular-nums">${fmtD(r.gross_sales)}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {r.ads_basis === "unknown" ? "—" : `$${fmtD(r.ad_spend)}`}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">${fmtD(r.est_cogs)}</td>
                  <td className={`py-1 text-right tabular-nums font-medium ${moneyClass(r.net_after_ads)}`}>
                    ${fmtD(r.net_after_ads)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {top.length === 0 ? (
        <p className="text-xs text-muted-foreground">No SKU lines for this period.</p>
      ) : (
        <div className="space-y-1 text-xs">
          <p className="font-medium">Top SKUs by contribution{skuLines.length > top.length ? ` (${skuLines.length})` : ""}</p>
          {top.map((s) => (
            <div key={s.sku} className="flex justify-between gap-3">
              <span className="truncate text-muted-foreground" title={s.title ?? s.sku}>{s.sku}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {fmt(s.units)}u · ${fmtD(s.est_cogs)} COGS
              </span>
              <span className={`shrink-0 tabular-nums font-medium ${s.est_contribution >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                ${fmtD(s.est_contribution)}
              </span>
            </div>
          ))}
        </div>
      )}
      {dailyRows.length > 0 && period.grain === "month" && (
        <div>
          <p className="mb-2 text-xs font-medium">
            Stored daily P&amp;L
            <span className="ml-1 font-normal text-muted-foreground">
              ({dailyRows.length} day{dailyRows.length === 1 ? "" : "s"} — may not cover the full month)
            </span>
          </p>
          <PeriodDays
            period={{
              ...period,
              rows: dailyRows.filter((r) => !asOf || r.date <= asOf),
              openRows: dailyRows.filter((r) => asOf && r.date > asOf),
              days: dailyRows.filter((r) => !asOf || r.date <= asOf).length,
            }}
            asOf={asOf}
            expandedDay={expandedDay}
            onToggleDay={onToggleDay}
          />
        </div>
      )}
    </div>
  );
}

function PeriodDays({
  period,
  asOf,
  expandedDay,
  onToggleDay,
}: {
  period: PnlPeriod;
  asOf: string | null;
  expandedDay: string | null;
  onToggleDay: (date: string) => void;
}) {
  const days = [...period.openRows, ...period.rows];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {period.label}: {period.days} closed day{period.days === 1 ? "" : "s"}
        {period.avgDaily != null && (
          <>
            {" · "}
            <span className={`tabular-nums font-medium ${moneyClass(period.avgDaily)}`}>
              ${fmtD(period.avgDaily)}
            </span>
            {" avg / day"}
          </>
        )}
        . Click a day for the SKU / campaign split.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pb-1 text-left font-medium">Date</th>
              <th className="pb-1 text-right font-medium">Sales</th>
              <th className="pb-1 text-right font-medium">Ads</th>
              <th className="pb-1 text-right font-medium">COGS</th>
              <th className="pb-1 text-right font-medium">Contribution</th>
            </tr>
          </thead>
          <tbody>
            {days.map((r) => {
              const open = Boolean(asOf && r.date > asOf);
              const shown = expandedDay === r.date;
              return (
                <Fragment key={r.date}>
                  <tr
                    className={`cursor-pointer ${open ? "opacity-60" : "hover:bg-muted/60"}`}
                    tabIndex={0}
                    aria-expanded={shown}
                    onClick={() => onToggleDay(r.date)}
                    onKeyDown={(e) => toggleKey(e, () => onToggleDay(r.date))}
                  >
                    <td className="py-1 tabular-nums">
                      <span className="flex items-center gap-1.5">
                        <ChevronRight className={`h-3 w-3 text-muted-foreground transition-transform ${shown ? "rotate-90" : ""}`} />
                        {r.date}
                        {open && <span className="text-muted-foreground"> · preliminary</span>}
                      </span>
                    </td>
                    <td className="py-1 text-right tabular-nums">${fmtD(r.gross_sales)}</td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">${fmtD(r.ad_spend)}</td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">${fmtD(r.est_cogs)}</td>
                    <td className={`py-1 text-right tabular-nums font-medium ${moneyClass(r.net_after_ads)}`}>
                      ${fmtD(r.net_after_ads)}
                    </td>
                  </tr>
                  {shown && (
                    <tr>
                      <td colSpan={5} className="py-3">
                        <DayDetail date={r.date} row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SkuLine {
  sku: string; gross_sales: number; units: number; ad_spend: number;
  est_referral_fees: number; est_fba_fees: number; est_cogs: number;
  est_contribution: number;
}
interface CampaignLine { campaign_name: string; spend: number; sales: number }
interface DayData {
  date: string;
  skus: SkuLine[];
  campaigns: CampaignLine[];
  adSpendTotal: number;
  feesBasis: string;
  cogsBasis: string | null;
  settledPayout: number | null;
}

function DayDetail({ date, row }: { date: string; row: PnlRow }) {
  const [day, setDay] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pnl/day?date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(String(d.error));
        else setDay(d);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [date]);

  if (!row) {
    return <p className="text-xs text-muted-foreground">No stored account row for {date}.</p>;
  }

  const fees = Number(row.est_referral_fees ?? 0) + Number(row.est_fba_fees ?? 0);
  const skus = (day?.skus ?? []).filter((s) => s.sku !== "__unallocated__");
  const topSkus = [...skus].sort((a, b) => b.est_contribution - a.est_contribution).slice(0, 8);

  return (
    <div className="grid gap-6 whitespace-normal lg:grid-cols-3">
      <div>
        <p className="mb-2 text-xs font-medium">Day waterfall</p>
        <div className="space-y-1 text-xs">
          {[
            { label: "Gross sales", value: Number(row.gross_sales ?? 0), color: "" },
            { label: "− Referral fees", value: -Number(row.est_referral_fees ?? 0), color: "text-red-500" },
            { label: "− FBA fees", value: -Number(row.est_fba_fees ?? 0), color: "text-red-500" },
            { label: "− Ad spend", value: -Number(row.ad_spend ?? 0), color: "text-red-500" },
            { label: "− COGS", value: -Number(row.est_cogs ?? 0), color: "text-red-500" },
            { label: "= Contribution", value: Number(row.net_after_ads ?? 0), color: Number(row.net_after_ads ?? 0) >= 0 ? "font-semibold text-emerald-600" : "font-semibold text-red-600" },
          ].map((l) => (
            <div key={l.label} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{l.label}</span>
              <span className={`tabular-nums ${l.color}`}>${fmtD(Math.abs(l.value))}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          {fees > 0 && `Fees ${day?.feesBasis ?? row.fees_basis ?? "estimated"}. `}
          {day?.cogsBasis === "sku_units_x_sku_costs"
            ? "COGS = daily units × sku_costs."
            : "COGS estimated from order-count units."}
          {day?.settledPayout != null && ` Settlement posted this day: $${fmtD(day.settledPayout)} (cash, not margin).`}
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">
          Top SKUs by contribution
          {skus.length > 0 && <span className="ml-1 font-normal text-muted-foreground">({skus.length} with sales)</span>}
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!error && !day && <p className="text-xs text-muted-foreground">Loading…</p>}
        {day && topSkus.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No SKU-grain rows for this day — run <code>pnl-sync</code> to store them.
          </p>
        )}
        {topSkus.length > 0 && (
          <div className="space-y-1 text-xs">
            {topSkus.map((s) => (
              <div key={s.sku} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground" title={s.sku}>{s.sku}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {fmt(s.units)}u · ${fmtD(s.est_cogs)} COGS
                </span>
                <span className={`shrink-0 tabular-nums font-medium ${s.est_contribution >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  ${fmtD(s.est_contribution)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">Ad spend</p>
        <p className="text-xs text-muted-foreground">
          Account total <span className="tabular-nums font-medium text-foreground">${fmtD(row.ad_spend)}</span>
          {" "}— campaign-level, so it is not attributed to a SKU above.
        </p>
        {day && day.campaigns.length > 0 && (
          <div className="mt-2 space-y-1 text-xs">
            {day.campaigns.slice(0, 6).map((c) => (
              <div key={c.campaign_name} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground" title={c.campaign_name}>{c.campaign_name}</span>
                <span className="shrink-0 tabular-nums">${fmtD(c.spend)}</span>
              </div>
            ))}
            {day.campaigns.length > 6 && (
              <p className="text-[10px] text-muted-foreground">
                +{day.campaigns.length - 6} more campaigns
              </p>
            )}
          </div>
        )}
        {day && day.campaigns.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">No campaign rows for this date.</p>
        )}
      </div>
    </div>
  );
}
