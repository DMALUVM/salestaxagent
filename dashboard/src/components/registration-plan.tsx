"use client";

import { useEffect, useState } from "react";
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
  documentation_status?: string;
  citation?: string;
  packet_date?: string;
  authority_source?: string;
}

type Tab =
  | "register_now" | "needs_statute_review" | "review_contested" | "monitor"
  | "already_registered" | "no_sales_tax";

const TABS: Tab[] = [
  "register_now", "needs_statute_review", "review_contested", "monitor",
  "already_registered", "no_sales_tax",
];

const TAB_LABELS: Record<Tab, string> = {
  register_now: "Register now",
  needs_statute_review: "Needs statute review",
  review_contested: "Contested",
  monitor: "Monitor",
  already_registered: "Already registered",
  no_sales_tax: "No sales tax",
};

const TAB_HELP: Record<Tab, string> = {
  register_now:
    "A documented trigger is met: the economic threshold is exceeded, or FBA inventory is held in a state with a Tess-documented assert (or a researched state_rules true). Citations shown. Not legal advice — do not auto-register.",
  needs_statute_review:
    "FBA inventory is flagged, but Tess has no statute-backed assert (unknown default or partial — FBA not named). This is not a quiet register-now.",
  review_contested:
    "Inventory is held here, but Tess documented a carve-out (IL/NY) or a fact-specific partial (AZ), or state_rules says FBA stock does not / may not create nexus. Confirm with a CPA first.",
  monitor:
    "No trigger yet. Approaching states show their percentage of the economic threshold.",
  already_registered: "Registered to collect, per nexus_status.",
  no_sales_tax: "No state sales tax exists, so registration is not possible.",
};

const ACTION_STYLES: Record<string, string> = {
  register_now:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900",
  needs_statute_review:
    "bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
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

const DOC_STYLES: Record<string, string> = {
  documented:
    "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  partial:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  unknown:
    "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-700",
};

function money(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";
}

export function RegistrationPlan() {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>("register_now");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [residual, setResidual] = useState<string>("");

  /**
   * Warehouse read — safe to load on mount. The old Python CLI path required
   * a click because it spawned a subprocess that does not exist on Vercel.
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
      if (!d.available) {
        setErr(
          d.error === "warehouse_empty"
            ? (d.hint ?? "The warehouse has no nexus or sales rows yet.")
            : (d.hint ?? d.error ?? "Could not load the registration plan from the warehouse."),
        );
      }
      setRows(d.rows ?? []);
      setCounts(d.counts ?? {});
      setResidual(typeof d.residual_risk === "string" ? d.residual_risk : "");
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the registration plan from the warehouse.");
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
        {loading && (
          <p className="text-xs text-muted-foreground">
            {rows.length > 0 ? "Refreshing plan from the warehouse…" : "Loading plan from the warehouse…"}
          </p>
        )}
        {err && (
          <div className="space-y-2">
            <p className="text-xs text-amber-700 dark:text-amber-400">{err}</p>
            {loaded && (
              <Button variant="outline" size="sm" className="text-xs" onClick={load}>
                Retry
              </Button>
            )}
          </div>
        )}

        {rows.length > 0 && (
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
                      <th className="py-1 pr-3">Doc.</th>
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
                                : r.physical_nexus === "flagged"
                                  ? ACTION_STYLES.needs_statute_review
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
                            className={`text-[9px] ${DOC_STYLES[r.documentation_status ?? "unknown"] ?? DOC_STYLES.unknown}`}
                          >
                            {r.documentation_status || "unknown"}
                          </Badge>
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
                          {r.citation && (
                            <p className="mt-0.5 text-[10px] text-foreground/80">
                              Cite: {r.citation}
                              {r.packet_date ? ` · Tess ${r.packet_date}` : ""}
                              {r.authority_source ? ` · ${r.authority_source}` : ""}
                            </p>
                          )}
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
                        <td colSpan={10} className="py-2 text-muted-foreground">
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
                guessed.
                {residual
                  ? ` ${residual}`
                  : " Unmapped fulfilment-centre codes can hide inventory in a state — check inventory health for residual risk."}
              </p>
            )}
            <Button variant="outline" size="sm" className="text-xs" onClick={load} disabled={loading}>
              Refresh plan
            </Button>
          </>
        )}

        <p className="text-[10px] text-muted-foreground">
          Sales tax only. Entity and business-activity taxes (CA $800, WA B&amp;O,
          OR CAT) are a separate decision — see{" "}
          <a href="/entity" className="text-blue-600 hover:underline dark:text-blue-400">
            Entity &amp; compliance
          </a>
          . Tess FBA citation packets dated 2026-09-11. Monitoring aid —{" "}
          <span className="font-medium">not legal advice</span>;
          confirm positions with a CPA before registering or filing. Do not auto-register.
        </p>
      </CardContent>
    </Card>
  );
}
