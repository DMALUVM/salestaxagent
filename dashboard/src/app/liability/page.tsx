"use client";

import { useMemo } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type {
  NexusStatus,
  StateRule,
  SalesByState,
  FilingEntry,
} from "@/lib/types";
import {
  normalizeChannel,
  SHOPIFY,
  AMAZON,
  STATE_TAX_RATES,
} from "@/lib/channels";
import { isRegistered } from "@/lib/compliance-status";
import { LoadingState } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DollarSign,
  AlertTriangle,
  ShieldCheck,
  Store,
  Info,
  CalendarClock,
  Download,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

/**
 * Resolve the date after which sales have NOT been filed yet.
 *
 * Sources (in priority order):
 *   1. nexus_status.last_filed_through — user-entered ISO date
 *   2. filing_calendar — period_end of the most recently filed entry
 *
 * Returns the cutoff date string (ISO), or null if nothing has been filed.
 */
function resolveFiledThrough(
  n: NexusStatus,
  filedEntries: FilingEntry[],
): string | null {
  if (n.last_filed_through) return n.last_filed_through;

  let latest: string | null = null;
  for (const f of filedEntries) {
    if (f.state_code !== n.state_code || f.status !== "filed") continue;
    if (!latest || f.period_end > latest) latest = f.period_end;
  }
  return latest;
}

/**
 * Compute the next unfiled period's due date from filed_through + frequency.
 *
 * Rules:
 *   1. Next period starts the day after filed_through.
 *   2. Period end = end of the calendar month/quarter/half/year containing that start.
 *   3. Due date = dueDay of the month after period end.
 *   4. NEVER returns a due date whose period_end <= filed_through.
 *   5. If filed_through is null, returns null (no mass OVERDUE).
 *
 * Examples:
 *   MD quarterly, filed_through=2026-06-30, due_day=20
 *     → next period = Q3 2026 (07-01 to 09-30), due = 2026-10-20
 *   WV monthly, filed_through=2026-06-30, due_day=20
 *     → next period = July 2026 (07-01 to 07-31), due = 2026-08-20
 *   OH semi_annual, filed_through=2026-06-30, due_day=20
 *     → next period = H2 2026 (07-01 to 12-31), due = 2027-01-20
 */
function computeNextDue(
  filedThrough: string | null,
  frequency: string | null,
  dueDay: number,
): { due: string; days: number; periodEnd: string } | null {
  if (!filedThrough || !frequency) return null;

  const ft = new Date(filedThrough + "T00:00:00");
  // Next period starts the day after filed_through
  const start = new Date(ft);
  start.setDate(start.getDate() + 1);

  const y = start.getFullYear();
  const m = start.getMonth(); // 0-based

  let periodEndDate: Date;
  const freq = frequency.toLowerCase().replace("-", "_");

  if (freq === "monthly") {
    // Period = the calendar month containing `start`
    periodEndDate = new Date(y, m + 1, 0); // last day of month
  } else if (freq === "quarterly") {
    // Quarter containing `start`
    const qEnd = Math.floor(m / 3) * 3 + 2; // 0-based month of quarter end
    periodEndDate = new Date(y, qEnd + 1, 0);
  } else if (freq === "semi_annual" || freq === "semi-annual") {
    // H1 = Jan-Jun, H2 = Jul-Dec
    periodEndDate = m < 6 ? new Date(y, 6, 0) : new Date(y, 12, 0);
  } else if (freq === "annual") {
    periodEndDate = new Date(y, 12, 0); // Dec 31
  } else {
    // Unknown frequency — fall back to monthly
    periodEndDate = new Date(y, m + 1, 0);
  }

  // Due date = dueDay of month after period end
  const dueMonth = periodEndDate.getMonth() + 1;
  const dueYear =
    dueMonth > 11
      ? periodEndDate.getFullYear() + 1
      : periodEndDate.getFullYear();
  const dueDate = new Date(dueYear, dueMonth % 12, Math.min(dueDay, 28));

  const periodEnd = periodEndDate.toISOString().slice(0, 10);
  const due = dueDate.toISOString().slice(0, 10);
  const days = Math.ceil(
    (dueDate.getTime() - Date.now()) / 86400000,
  );

  return { due, days, periodEnd };
}

interface StateLiability {
  state_code: string;
  state_name: string;
  rate: number;
  frequency: string | null;
  next_due: string | null;
  next_due_days: number | null;
  filed_through: string | null;
  has_filed_through: boolean;
  shopify_since_filing: number;
  amazon_since_filing: number;
  seller_est_tax: number;
  shopify_all_time: number;
  amazon_all_time: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LiabilityPage() {
  const { data: nexus, loading: l1 } = useSupabaseQuery<NexusStatus>(
    "nexus_status",
  );
  const { data: rules, loading: l2 } = useSupabaseQuery<StateRule>(
    "state_rules",
  );
  const { data: sales, loading: l3 } = useSupabaseQuery<SalesByState>(
    "sales_by_state",
  );
  const { data: filings, loading: l4 } = useSupabaseQuery<FilingEntry>(
    "filing_calendar",
    { orderBy: "due_date", ascending: true },
  );

  const ruleMap = useMemo(() => {
    const m: Record<string, StateRule> = {};
    for (const r of rules) m[r.state_code] = r;
    return m;
  }, [rules]);

  const liabilities = useMemo(() => {
    const registered = nexus.filter((n) => isRegistered(n.is_registered));
    if (registered.length === 0) return [];

    const rows: StateLiability[] = [];

    for (const n of registered) {
      const sc = n.state_code;
      const rule = ruleMap[sc];
      if (!rule || !rule.has_sales_tax) continue;

      const filedThrough = resolveFiledThrough(n, filings);
      const rate = STATE_TAX_RATES[sc] ?? 0;
      const freq = n.assigned_frequency ?? rule.filing_frequency_default;
      const dueDay = rule.typical_due_day ?? 20;

      // Compute next due from filed_through + frequency.
      // If filed_through is null → no next_due (amber "Set date" prompt).
      const nd = computeNextDue(filedThrough, freq, dueDay);

      let shopAll = 0;
      let shopSince = 0;
      let amzAll = 0;
      let amzSince = 0;

      for (const s of sales) {
        if (s.state_code !== sc) continue;
        const ch = normalizeChannel(s.channel);
        const amt = s.gross_sales;
        // Only count sales AFTER filed_through.
        // If filed_through is null → show $0 (NOT all-time).
        const afterFiling = filedThrough ? s.period_end > filedThrough : false;

        if (ch === SHOPIFY) {
          shopAll += amt;
          if (afterFiling) shopSince += amt;
        } else if (ch === AMAZON) {
          amzAll += amt;
          if (afterFiling) amzSince += amt;
        }
      }

      rows.push({
        state_code: sc,
        state_name: rule.state_name ?? sc,
        rate,
        frequency: freq,
        next_due: nd?.due ?? null,
        next_due_days: nd?.days ?? null,
        filed_through: filedThrough,
        has_filed_through: !!filedThrough,
        shopify_since_filing: shopSince,
        amazon_since_filing: amzSince,
        seller_est_tax: shopSince * rate,
        shopify_all_time: shopAll,
        amazon_all_time: amzAll,
      });
    }

    rows.sort((a, b) => b.seller_est_tax - a.seller_est_tax);
    return rows;
  }, [nexus, sales, ruleMap, filings]);

  if (l1 || l2 || l3 || l4) return <LoadingState />;

  const totals = liabilities.reduce(
    (acc, r) => ({
      shopify: acc.shopify + r.shopify_since_filing,
      amazon: acc.amazon + r.amazon_since_filing,
      seller_tax: acc.seller_tax + r.seller_est_tax,
    }),
    { shopify: 0, amazon: 0, seller_tax: 0 },
  );

  const missingDates = liabilities.filter((r) => !r.has_filed_through);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            What Do I Owe?
          </h1>
          <p className="text-sm text-muted-foreground">
            Shopify sales since last filing &times; state rate &middot; Amazon
            shown for reference only
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            window.open("/api/export-csv?table=sales_by_state", "_blank");
          }}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1 text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">Estimate only &mdash; not for filing</p>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Base state-level rates, no local surcharges. Amazon collects and
            remits on its orders &mdash; those are{" "}
            <strong>not your liability</strong>. Consult your CPA for
            filing-ready numbers.
          </p>
        </div>
      </div>

      {/* Prompt to set last-filed-through dates */}
      {missingDates.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="space-y-1 text-sm text-blue-800 dark:text-blue-300">
            <p className="font-medium">
              Set &ldquo;Last Filed Through&rdquo; for accurate numbers
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-400">
              {missingDates.length === 1
                ? `${missingDates[0].state_code} is`
                : `${missingDates.map((d) => d.state_code).join(", ")} are`}{" "}
              missing a last-filed date. Until set, no sales or due dates
              are shown for {missingDates.length === 1 ? "this state" : "these states"}. Set it on the{" "}
              <a href="/registrations" className="underline font-medium">
                Registrations
              </a>{" "}
              page (edit the state &rarr; &ldquo;Last Filed Through&rdquo;
              field, enter a date like 2025-06-30).
            </p>
          </div>
        </div>
      )}

      {liabilities.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p>No registered states found.</p>
            <p className="mt-1 text-xs">
              Mark states as registered on the{" "}
              <a href="/registrations" className="underline">
                Registrations
              </a>{" "}
              page first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Store className="h-3.5 w-3.5" />
                  Shopify Since Last Filing
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">
                  ${fmt(totals.shopify)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Unfiled direct sales you owe tax on
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <DollarSign className="h-3.5 w-3.5" />
                  Est. Tax This Period
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
                  ${fmt(totals.seller_tax)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Shopify sales &times; base state rate
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  Amazon Since Last Filing (ref)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-muted-foreground">
                  ${fmt(totals.amazon)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Amazon remits &mdash; not your liability
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Detail table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                By State &mdash; Since Last Filing
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">State</TableHead>
                      <TableHead className="w-20">Filing</TableHead>
                      <TableHead className="w-24">Next Due</TableHead>
                      <TableHead className="w-28">Filed Thru</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">
                        Shopify This Period
                      </TableHead>
                      <TableHead className="text-right">
                        Est. Tax Owed
                      </TableHead>
                      <TableHead className="text-right text-muted-foreground">
                        Amazon (ref)
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liabilities.map((row) => (
                      <TableRow key={row.state_code}>
                        <TableCell>
                          <div>
                            <span className="font-medium">
                              {row.state_code}
                            </span>
                            <span className="ml-1.5 hidden text-xs text-muted-foreground sm:inline">
                              {row.state_name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {row.frequency ? (
                            <Badge
                              variant="outline"
                              className="text-xs capitalize"
                            >
                              {row.frequency.replace("_", "-")}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              &mdash;
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.next_due && row.has_filed_through ? (
                            <div>
                              <span
                                className={`text-xs font-medium ${
                                  (row.next_due_days ?? 99) < 0
                                    ? "text-red-600 dark:text-red-400"
                                    : (row.next_due_days ?? 99) <= 14
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {(row.next_due_days ?? 0) < 0
                                  ? "OVERDUE"
                                  : (row.next_due_days ?? 0) === 0
                                  ? "TODAY"
                                  : `${row.next_due_days}d`}
                              </span>
                              <span className="ml-1 text-xs text-muted-foreground">
                                {row.next_due.slice(5)}
                              </span>
                            </div>
                          ) : !row.has_filed_through ? (
                            <a
                              href="/registrations"
                              className="text-xs text-amber-600 underline dark:text-amber-400"
                            >
                              Set filed-through
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              &mdash;
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.filed_through ? (
                            <span className="text-xs text-muted-foreground">
                              {row.filed_through}
                            </span>
                          ) : (
                            <a
                              href="/registrations"
                              className="text-xs text-blue-600 underline dark:text-blue-400"
                            >
                              Set date
                            </a>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {pct(row.rate)}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {row.shopify_since_filing > 0 ? (
                            `$${fmt(row.shopify_since_filing)}`
                          ) : (
                            <span className="text-muted-foreground">
                              $0.00
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium tabular-nums">
                          {row.seller_est_tax > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400">
                              ${fmt(row.seller_est_tax)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">
                              $0.00
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {row.amazon_since_filing > 0
                            ? `$${fmt(row.amazon_since_filing)}`
                            : "$0.00"}
                        </TableCell>
                      </TableRow>
                    ))}

                    <TableRow className="border-t-2 font-semibold">
                      <TableCell>Total</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right tabular-nums">
                        ${fmt(totals.shopify)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                        ${fmt(totals.seller_tax)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        ${fmt(totals.amazon)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Explanation */}
          <Card>
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    <strong>Shopify This Period</strong> = direct sales in this
                    state since the &ldquo;Filed Thru&rdquo; date. If no date
                    is set, all-time Shopify sales are shown. Set the date on
                    the{" "}
                    <a href="/registrations" className="underline">
                      Registrations
                    </a>{" "}
                    page after filing.
                  </p>
                  <p>
                    <strong>Est. Tax Owed</strong> = Shopify this period &times;
                    base state rate. Compare against what you collected at
                    Shopify checkout.
                  </p>
                  <p>
                    <strong>Amazon (ref)</strong> = marketplace sales since last
                    filing, for context only. Amazon collects and remits
                    &mdash; you do <em>not</em> re-remit these, but most states
                    require you to report them on your return.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
