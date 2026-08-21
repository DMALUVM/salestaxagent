"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Shopify customer economics — read-only.
 *
 * Loads on mount.
 *
 * It was click-to-load, which was the wrong call: the card sat at the 91% mark
 * of /profit showing a "Load" button and no numbers, so the panel looked
 * missing in production even though the deploy, the env and the API were all
 * healthy. A metric nobody can see without hunting for a button is not shipped.
 * The route is a pure Supabase aggregate — render-safety only forbids
 * mount-fetching routes that shell out to Python, which this does not.
 *
 * Every definition is shown beside the numbers. These metrics are easy to quote
 * and easy to misread — a repeat rate means nothing without knowing how a
 * customer was identified, and an LTV mean means little without the median.
 */
interface Summary {
  orders: number; revenue: number; customers: number;
  aov: number; aovMedian: number; aovPaid: number; aovPaidMedian: number;
  ltvMean: number; ltvMedian: number;
  ltvMeanRepeat: number | null; ltvMedianRepeat: number | null;
  repeatCustomers: number; repeatRate: number;
  ordersPerRepeater: number | null;
  revenueFromRepeaters: number; revenueFromRepeatersPct: number | null;
  ordersPerCustomer: number; identifiedPct: number;
  interpretation: string;
  firstOrderDate: string; lastOrderDate: string;
}
interface YearRow {
  year: string; orders: number; aov: number; aovMedian: number;
  aovPaid: number; revenue: number;
}
interface CohortOffset {
  offset: number; cumRevenuePerCustomer: number | null; observed: boolean;
}
interface Payload {
  available: boolean;
  empty?: boolean;
  summary?: Summary;
  byYear?: YearRow[];
  monthly?: { month: string; orders: number; revenue: number; aov: number | null;
              newCustomers: number }[];
  cohorts?: { cohort: string; customers: number; offsets: CohortOffset[] }[];
  definitions?: [string, string][];
  amazon?: { personLevelAvailable: boolean; why: string[]; doNotDo: string;
             available: string };
  setupHint?: string | null;
  error?: string | null;
}

const money = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: dp,
                                        maximumFractionDigits: dp })}`;

export function ShopifyCustomers() {
  const [d, setD] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDefs, setShowDefs] = useState(false);

  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setBusy(true);
    try {
      const res = await fetch("/api/shopify-customers");
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Unexpected ${res.status} response.`);
      }
      setD(await res.json());
    } catch (e) {
      setD({ available: false,
             error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const s = d?.summary;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Shopify customer economics
            <span className="ml-2 font-normal text-muted-foreground">
              {s ? `${s.firstOrderDate} → ${s.lastOrderDate}` : "AOV · LTV · repeat · cohorts"}
            </span>
          </CardTitle>
          <div className="flex gap-2">
            {d && (
              <Button variant="ghost" size="sm"
                      onClick={() => setShowDefs((v) => !v)}>
                {showDefs ? "Hide definitions" : "Definitions"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={load} disabled={busy}>
              {busy ? "Loading…" : "Refresh"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!d && busy && (
          <div className="space-y-2" aria-busy="true">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="h-20 animate-pulse rounded-md bg-muted" />
              <div className="h-20 animate-pulse rounded-md bg-muted" />
            </div>
            <p className="text-xs text-muted-foreground">
              Aggregating {"~"}14k Shopify orders…
            </p>
          </div>
        )}

        {/* An error must look like an error, and must say what to DO about it.
            A blank card is indistinguishable from a store with no customers. */}
        {d && !d.available && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive">
              Customer metrics could not load
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {d.setupHint ?? d.error ?? "Unknown error."}
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={load}
                    disabled={busy}>
              Try again
            </Button>
          </div>
        )}

        {d?.available && d.empty && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              No Shopify orders stored yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {d.setupHint ?? "Run the backfill on the agent."}
            </p>
          </div>
        )}

        {s && (
          <>
            {/* The interpretation leads. Without it the all-customer median
                reads as "our customers are worth $13", which is the reading
                the operator rejected — it describes acquisition mix, not what
                a retained customer is worth. */}
            <p className="rounded-md border-l-2 border-primary bg-muted/40 px-3 py-2 text-xs">
              {s.interpretation}
            </p>

            <div>
              <p className="text-[10px] uppercase text-muted-foreground mb-1">
                Order value — {s.orders.toLocaleString()} orders
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="AOV — net merchandise" value={money(s.aov)}
                      sub={`median ${money(s.aovMedian)} · excl. tax & shipping`} />
                <Stat label="AOV — total paid" value={money(s.aovPaid)}
                      sub={`median ${money(s.aovPaidMedian)} · matches Shopify Admin`} />
              </div>
            </div>

            <div>
              <p className="text-[10px] uppercase text-muted-foreground mb-1">
                Lifetime value
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Repeaters (2+ orders) — primary"
                      value={money(s.ltvMeanRepeat)}
                      sub={`median ${money(s.ltvMedianRepeat)} · what a retained buyer is worth`}
                      accent />
                <Stat label="All customers"
                      value={money(s.ltvMean)}
                      sub={`median ${money(s.ltvMedian)} — typical customer ever (mostly one-time)`} />
              </div>
            </div>

            <div>
              <p className="text-[10px] uppercase text-muted-foreground mb-1">
                Repeat behaviour
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Repeat rate"
                      value={`${(s.repeatRate * 100).toFixed(1)}%`}
                      sub={`${s.repeatCustomers.toLocaleString()} of ${s.customers.toLocaleString()}`} />
                <Stat label="Orders / repeater"
                      value={s.ordersPerRepeater?.toFixed(2) ?? "—"}
                      sub={`all customers ${s.ordersPerCustomer.toFixed(2)}`} />
                <Stat label="Revenue from repeaters"
                      value={s.revenueFromRepeatersPct === null ? "—"
                             : `${s.revenueFromRepeatersPct.toFixed(0)}%`}
                      sub={money(s.revenueFromRepeaters, 0)} />
                <Stat label="Net revenue" value={money(s.revenue, 0)}
                      sub={`${s.firstOrderDate} → ${s.lastOrderDate}`} />
              </div>
            </div>

            {d.byYear && d.byYear.length > 1 && (
              <div>
                <p className="text-[10px] uppercase text-muted-foreground mb-1">
                  Order value by year — an all-time AOV blends different eras
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-3">Year</th>
                        <th className="py-1 pr-3 text-right">Orders</th>
                        <th className="py-1 pr-3 text-right">AOV net</th>
                        <th className="py-1 pr-3 text-right">AOV paid</th>
                        <th className="py-1 pr-3 text-right">Median</th>
                        <th className="py-1 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.byYear.map((y) => (
                        <tr key={y.year} className="border-t">
                          <td className="py-1 pr-3 tabular-nums">{y.year}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {y.orders.toLocaleString()}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">{money(y.aov)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{money(y.aovPaid)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{money(y.aovMedian)}</td>
                          <td className="py-1 text-right tabular-nums">{money(y.revenue, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Identity coverage sits next to the repeat rate on purpose: it is
                the ceiling on how much that number can mean. */}
            <p className="text-[10px] text-muted-foreground">
              {s.identifiedPct.toFixed(0)}% of customers have a Shopify customer
              id; the rest are guest checkouts stitched by email hash, or single
              orders that can never count as repeat.
            </p>

            {d.cohorts && d.cohorts.length > 0 && (
              <div>
                <p className="text-[10px] uppercase text-muted-foreground mb-1">
                  Cohorts — cumulative revenue per customer, by month after first order
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-3">Cohort</th>
                        <th className="py-1 pr-3 text-right">Cust.</th>
                        {d.cohorts[0].offsets.map((o) => (
                          <th key={o.offset} className="py-1 pr-3 text-right">
                            m{o.offset}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {d.cohorts.map((c) => (
                        <tr key={c.cohort} className="border-t">
                          <td className="py-1 pr-3 tabular-nums">{c.cohort}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {c.customers.toLocaleString()}
                          </td>
                          {c.offsets.map((o) => (
                            <td key={o.offset}
                                className="py-1 pr-3 text-right tabular-nums">
                              {o.observed ? money(o.cumRevenuePerCustomer, 0)
                                          : <span className="text-muted-foreground/50">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  &ldquo;—&rdquo; means that month has not happened yet for the
                  cohort. It is not zero spend.
                </p>
              </div>
            )}

            {showDefs && d.definitions && (
              <div className="rounded-md border p-3">
                <p className="text-[10px] uppercase text-muted-foreground mb-1">
                  Definitions
                </p>
                <dl className="space-y-1">
                  {d.definitions.map(([term, def]) => (
                    <div key={term} className="text-[11px]">
                      <dt className="inline font-medium">{term}: </dt>
                      <dd className="inline text-muted-foreground">{def}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}

        {d?.amazon && (
          <div className="rounded-md border border-amber-500/30 p-3">
            <p className="text-[10px] uppercase text-muted-foreground mb-1">
              Amazon — person-level metrics are not available
            </p>
            <ul className="space-y-0.5">
              {d.amazon.why.map((w, i) => (
                <li key={i} className="text-[11px] text-muted-foreground">• {w}</li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              {d.amazon.doNotDo}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              What is available: {d.amazon.available}
            </p>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          Source: Shopify Admin API orders, stored per order by
          <span className="font-medium"> shopify-backfill</span>. Read-only here.
          Raw email is not stored — identity uses the Shopify customer id and a
          salt-free hash for guest stitching.{" "}
          <Badge variant="outline" className="text-[9px]">Shopify only</Badge>
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub, accent }: {
  label: string; value: string; sub: string; accent?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${accent ? "border-primary/50 bg-primary/5" : ""}`}>
      <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}
