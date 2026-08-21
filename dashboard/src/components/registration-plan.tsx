"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Ranked sales-tax registration plan.
 *
 * Sales tax only. Entity and business-activity taxes (CA $800, WA B&O, OR CAT)
 * never appear here as a reason to register — they are a different tax with a
 * different agency, and are footnoted through to /entity instead.
 */

interface PlanRow {
  state: string;
  sales_tax: string;
  already_registered: string;
  physical_nexus: string;
  first_inventory_date: string;
  economic_nexus: string;
  shopify_sales: string;
  amazon_sales: string;
  total_relevant_sales: string;
  recommended_action: string;
  short_reason: string;
  confidence: string;
  entity_note: string;
}

type Tab =
  | "register_now" | "review_contested" | "monitor"
  | "already_registered" | "no_sales_tax";

const TABS: Tab[] = [
  "register_now", "review_contested", "monitor",
  "already_registered", "no_sales_tax",
];

const TAB_LABELS: Record<Tab, string> = {
  register_now: "Register now",
  review_contested: "Contested",
  monitor: "Monitor",
  already_registered: "Already registered",
  no_sales_tax: "No sales tax",
};

const TAB_HELP: Record<Tab, string> = {
  register_now:
    "A nexus trigger is met: the economic threshold is exceeded, or FBA inventory is held in a state whose rules treat that as creating nexus.",
  review_contested:
    "Inventory is held here, but the state's rule says FBA stock does not (or may not) create nexus. Registering creates filing obligations that are awkward to unwind — confirm with a CPA first.",
  monitor:
    "No trigger yet. Approaching states show their percentage of the economic threshold.",
  already_registered: "Registered to collect, per nexus_status.",
  no_sales_tax: "No state sales tax exists, so registration is not possible.",
};

const ACTION_STYLES: Record<string, string> = {
  register_now:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900",
  review_contested:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  monitor:
    "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
  already_registered:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  no_sales_tax:
    "bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/60 dark:text-slate-500 dark:border-slate-700",
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  medium: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  low: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

function money(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";
}

export function RegistrationPlan() {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>("register_now");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Loaded ON DEMAND. This route shells out to the Python CLI, so fetching it
   * from a mount effect spawned a subprocess on every page view — impossible on
   * a serverless deploy where the venv does not exist, and it made an optional
   * panel a hard dependency of the page rendering at all.
   */
  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/registration-plan");
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Unexpected ${res.status} response from the plan route.`);
      }
      const d = await res.json();
      if (!d.available) setErr(d.hint ?? d.error ?? "Plan unavailable.");
      setRows(d.rows ?? []);
      setCounts(d.counts ?? {});
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the registration plan.");
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  const shown = rows.filter((r) => r.recommended_action === tab);
  const compact = tab === "already_registered" || tab === "no_sales_tax";
  const residualNote = rows.length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Sales-tax registration plan
          <span className="ml-2 font-normal text-muted-foreground">
            ranked from live inventory + sales
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!loaded && !loading && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Ranks every state from live inventory and sales. Built on demand so
              the page never waits on it.
            </p>
            <Button variant="outline" size="sm" className="text-xs" onClick={load}>
              Build registration plan
            </Button>
          </div>
        )}
        {loading && <p className="text-xs text-muted-foreground">Building plan…</p>}
        {err && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{err}</p>
        )}

        {!loading && rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-1">
              {TABS.map((t) => (
                <Button
                  key={t}
                  variant={tab === t ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() => setTab(t)}
                  title={TAB_HELP[t]}
                >
                  {TAB_LABELS[t]}
                  {counts[t] ? ` (${counts[t]})` : " (0)"}
                </Button>
              ))}
            </div>

            <p className="text-[10px] text-muted-foreground">{TAB_HELP[tab]}</p>

            {compact ? (
              <p className="text-xs tabular-nums">
                {shown.map((r) => r.state).join(", ") || "None."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-3">State</th>
                      <th className="py-1 pr-3">Physical</th>
                      <th className="py-1 pr-3">Inventory since</th>
                      <th className="py-1 pr-3">Economic</th>
                      <th className="py-1 pr-3 text-right">Shopify</th>
                      <th className="py-1 pr-3 text-right">Amazon</th>
                      <th className="py-1 pr-3 text-right">Total</th>
                      <th className="py-1 pr-3">Conf.</th>
                      <th className="py-1">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.state} className="border-t align-top">
                        <td className="py-1 pr-3 font-semibold">{r.state}</td>
                        <td className="py-1 pr-3">
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${
                              r.physical_nexus === "contested"
                                ? ACTION_STYLES.review_contested
                                : ""
                            }`}
                          >
                            {r.physical_nexus}
                          </Badge>
                        </td>
                        <td className="py-1 pr-3 tabular-nums text-muted-foreground">
                          {r.first_inventory_date || "—"}
                        </td>
                        <td className="py-1 pr-3 text-muted-foreground">
                          {r.economic_nexus}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {money(r.shopify_sales)}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {money(r.amazon_sales)}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums font-medium">
                          {money(r.total_relevant_sales)}
                        </td>
                        <td className="py-1 pr-3">
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${CONFIDENCE_STYLES[r.confidence] ?? ""}`}
                          >
                            {r.confidence}
                          </Badge>
                        </td>
                        <td className="py-1 text-muted-foreground">
                          {r.short_reason}
                          {r.entity_note && (
                            <p className="text-[10px]">
                              <a href="/entity" className="text-blue-600 hover:underline dark:text-blue-400">
                                {r.entity_note}
                              </a>
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-2 text-muted-foreground">
                          Nothing in this bucket.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {residualNote && (
              <p className="text-[10px] text-muted-foreground">
                No official registration URLs are stored in{" "}
                <code>state_rules.json</code>, so none are linked here rather than
                guessed. Unmapped fulfilment-centre codes can hide inventory in a
                state — check <code>inventory-health</code> for residual risk.
              </p>
            )}
          </>
        )}

        <p className="text-[10px] text-muted-foreground">
          Sales tax only. Entity and business-activity taxes (CA $800, WA B&amp;O,
          OR CAT) are a separate decision — see{" "}
          <a href="/entity" className="text-blue-600 hover:underline dark:text-blue-400">
            Entity &amp; compliance
          </a>
          . Monitoring aid — <span className="font-medium">not legal advice</span>;
          confirm positions with a CPA before registering or filing.
        </p>
      </CardContent>
    </Card>
  );
}
