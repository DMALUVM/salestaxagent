"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * 50 states + DC: non-sales-tax obligations for a remote ecommerce seller.
 *
 * The important UI decision is that `not_researched` renders as its own visible
 * state with an explicit caption, never as blank or green. 38 unexamined
 * jurisdictions shown as "clear" would be worse than not shipping the table.
 */

interface MatrixObligation {
  name: string;
  trigger: string;
  confidence: string;
  source_url: string;
  mode: string;
  note?: string;
}

interface MatrixRow {
  state: string;
  status: string;
  obligations?: MatrixObligation[];
  note?: string;
}

type StatusFilter = "all" | "verified_applies" | "not_researched" | "exposure";

const STATUS_STYLES: Record<string, string> = {
  verified_applies:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  verified_none:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  not_researched:
    "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-700",
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  medium: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  low: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: "All 51",
  verified_applies: "Verified applies",
  exposure: "Remote-seller exposure",
  not_researched: "Not researched",
};

const FILTER_HELP: Record<StatusFilter, string> = {
  all: "Every state and DC.",
  verified_applies: "An obligation was checked against an official source.",
  exposure:
    "Only obligations you can owe WITHOUT foreign-qualifying — the ones selling remotely can create on its own.",
  not_researched:
    "No verification has been done. This is NOT a finding that nothing is required.",
};

export function StateMatrix() {
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<StatusFilter>("verified_applies");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/state-matrix")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setCounts(d.counts ?? {});
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  const shown = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "exposure") {
      return (r.obligations ?? []).some((o) => o.trigger !== "qualification");
    }
    return r.status === filter;
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Entity &amp; business-activity by state
          <span className="ml-2 font-normal text-muted-foreground">
            50 states + DC · not sales tax
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Gross-receipts and business-activity taxes, entity franchise taxes and
          qualification-driven annual reports.{" "}
          <span className="font-medium">
            PL 86-272 protects only against net-income taxes
          </span>{" "}
          — it does not protect against WA B&amp;O, OH/OR CAT, TX franchise or DE
          gross receipts, which is why those can reach a seller with no offices
          or staff in the state.
        </p>

        <div className="flex flex-wrap items-center gap-1">
          {(["verified_applies", "exposure", "not_researched", "all"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              className="text-xs"
              onClick={() => setFilter(f)}
              title={FILTER_HELP[f]}
            >
              {FILTER_LABELS[f]}
              {f === "verified_applies" && counts.verified_applies
                ? ` (${counts.verified_applies})`
                : f === "not_researched" && counts.not_researched
                ? ` (${counts.not_researched})`
                : ""}
            </Button>
          ))}
        </div>

        <p className="text-[10px] text-muted-foreground">{FILTER_HELP[filter]}</p>

        {filter === "not_researched" ? (
          <div className="rounded-md border border-dashed p-3">
            <p className="text-xs font-medium">
              {shown.length} jurisdiction{shown.length === 1 ? "" : "s"} not yet examined
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Listed so the gap is visible. Do not read these as clear — nothing
              has been checked for them.
            </p>
            <p className="mt-2 text-xs tabular-nums">
              {shown.map((r) => r.state).join(", ")}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3">State</th>
                  <th className="py-1 pr-3">Obligation</th>
                  <th className="py-1 pr-3">Trigger</th>
                  <th className="py-1 pr-3">Conf.</th>
                  <th className="py-1 pr-3">Tracking</th>
                  <th className="py-1">Source</th>
                </tr>
              </thead>
              <tbody>
                {shown.flatMap((r) =>
                  (r.obligations ?? []).length === 0
                    ? [
                        <tr key={r.state} className="border-t">
                          <td className="py-1 pr-3 font-medium">{r.state}</td>
                          <td className="py-1 pr-3 text-muted-foreground" colSpan={5}>
                            <Badge variant="outline" className={`text-[9px] ${STATUS_STYLES[r.status] ?? ""}`}>
                              {r.status.replace(/_/g, " ")}
                            </Badge>{" "}
                            {r.note}
                          </td>
                        </tr>,
                      ]
                    : (r.obligations ?? [])
                        .filter((o) => filter !== "exposure" || o.trigger !== "qualification")
                        .map((o, i) => (
                          <tr key={`${r.state}-${i}`} className="border-t align-top">
                            <td className="py-1 pr-3 font-medium">{i === 0 ? r.state : ""}</td>
                            <td className="py-1 pr-3">
                              {o.name}
                              {o.note && (
                                <p className="text-[10px] text-muted-foreground">{o.note}</p>
                              )}
                            </td>
                            <td className="py-1 pr-3 text-muted-foreground">{o.trigger}</td>
                            <td className="py-1 pr-3">
                              <Badge variant="outline" className={`text-[9px] ${CONFIDENCE_STYLES[o.confidence] ?? ""}`}>
                                {o.confidence}
                              </Badge>
                            </td>
                            <td className="py-1 pr-3">
                              <Badge variant="outline" className="text-[9px]">
                                {o.mode === "review_only" ? "review only" : "scheduled"}
                              </Badge>
                            </td>
                            <td className="py-1">
                              <a
                                href={o.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline dark:text-blue-400"
                              >
                                official
                              </a>
                            </td>
                          </tr>
                        )),
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          Review-only items are enabled from the &ldquo;Review with a CPA&rdquo;
          section above — only after a CPA confirms they apply. Nothing here is
          scheduled from this table.
        </p>
      </CardContent>
    </Card>
  );
}
