"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/loading";
import { getSupabase } from "@/lib/supabase";

/**
 * Entity & compliance — obligations that exist because of what the ENTITY is
 * and where it is qualified, not because it collected tax from a buyer.
 *
 * Deliberately a separate page from the Filing Calendar. Nothing here is a
 * sales-tax return, and nothing here is gated on sales-tax registration.
 */

interface ObligationRow {
  id: string;
  state_code: string;
  obligation_type: string;
  form_code: string | null;
  title: string | null;
  period_label: string;
  due_date: string | null;
  due_rule_text: string | null;
  status: string;
  confidence: string | null;
  source_authority: string | null;
  source_citation: string | null;
  source_url: string | null;
  amount_estimate: number | null;
  notes: string | null;
  user_notes: string | null;
}

interface Payload {
  available: boolean;
  setupHint: string | null;
  error: string | null;
  overdue?: ObligationRow[];
  upcoming?: ObligationRow[];
  needsDate?: ObligationRow[];
  settled?: ObligationRow[];
  today?: string;
}

const TYPE_LABELS: Record<string, string> = {
  entity_annual: "Annual report",
  franchise_tax: "Franchise / privilege tax",
  foreign_llc_report: "Foreign qualification",
  get_excise: "Gross excise",
  other_local: "Other",
};

/** Confidence is about how well-established the rule is, not how urgent it is. */
const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  medium: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  low: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

function daysFrom(todayIso: string, dueIso: string): number {
  return Math.round(
    (Date.parse(`${dueIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000,
  );
}

function ObligationCard({
  row, today, onChanged,
}: {
  row: ObligationRow;
  today: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const days = row.due_date ? daysFrom(today, row.due_date) : null;
  const overdue = days !== null && days < 0;

  async function mark(status: "filed" | "not_required" | "dismissed") {
    const reason =
      status === "filed"
        ? window.prompt(`Mark ${row.state_code} ${row.form_code} ${row.period_label} as FILED.\n\nReference or note (optional):`, "")
        : window.prompt(
            `Mark ${row.state_code} ${row.form_code} ${row.period_label} as ${status.replace("_", " ").toUpperCase()}.\n\nWhy? (kept on the record)`,
            "",
          );
    if (reason === null) return;
    setBusy(true);
    const sb = getSupabase();
    await sb
      .from("compliance_obligations")
      .update({
        status,
        user_notes: reason.trim() || null,
        ...(status === "filed" ? { filed_date: today } : {}),
      })
      .eq("id", row.id);
    setBusy(false);
    onChanged();
  }

  return (
    <div className={`rounded-md border p-3 ${overdue ? "bg-red-50/50 dark:bg-red-950/20" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{row.state_code}</span>
            <span className="text-sm">{row.form_code}</span>
            <Badge variant="outline" className="text-[9px]">
              {TYPE_LABELS[row.obligation_type] ?? row.obligation_type}
            </Badge>
            {row.confidence && (
              <Badge
                variant="outline"
                className={`text-[9px] ${CONFIDENCE_STYLES[row.confidence] ?? ""}`}
                title="How well established the underlying rule is — not how urgent this is"
              >
                {row.confidence} confidence
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{row.title}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs tabular-nums font-medium">
            {row.due_date ?? "no due date"}
          </p>
          {days !== null && (
            <p className={`text-[10px] tabular-nums ${overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
              {overdue ? `${Math.abs(days)}d overdue` : days === 0 ? "today" : `in ${days}d`}
            </p>
          )}
          {row.amount_estimate ? (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              ~${Number(row.amount_estimate).toLocaleString()}
            </p>
          ) : null}
        </div>
      </div>

      {row.due_rule_text && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          <span className="font-medium">Due rule:</span> {row.due_rule_text}
        </p>
      )}
      {row.notes && <p className="mt-1 text-[10px] text-muted-foreground">{row.notes}</p>}
      {row.source_url && (
        <p className="mt-1 text-[10px]">
          <a
            href={row.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {row.source_authority} — {row.source_citation}
          </a>
        </p>
      )}

      <div className="mt-2 flex gap-1">
        <Button variant="outline" size="sm" className="text-xs" disabled={busy} onClick={() => mark("filed")}>
          Mark filed
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" disabled={busy} onClick={() => mark("not_required")}>
          Not required
        </Button>
        <Button variant="ghost" size="sm" className="text-xs" disabled={busy} onClick={() => mark("dismissed")}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export default function EntityPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    fetch("/api/entity-obligations")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData({ available: false, setupHint: null, error: "fetch failed" }))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <LoadingState />;

  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const overdue = data?.overdue ?? [];
  const upcoming = data?.upcoming ?? [];
  const needsDate = data?.needsDate ?? [];
  const settled = data?.settled ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Entity &amp; compliance</h1>
        <p className="text-sm text-muted-foreground">
          Annual reports, franchise taxes and foreign-qualification filings.
          These are <span className="font-medium">not</span> sales-tax returns —
          those live in the Filing Calendar and are gated on sales-tax registration.
        </p>
      </div>

      {!data?.available && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium">Not set up yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.setupHint ??
                data?.error ??
                "No obligations table found."}
            </p>
          </CardContent>
        </Card>
      )}

      {data?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ["Overdue", overdue.length, "text-red-600 dark:text-red-400"],
              ["Upcoming", upcoming.length, ""],
              ["Needs a date", needsDate.length, ""],
              ["Settled", settled.length, "text-muted-foreground"],
            ].map(([label, n, cls]) => (
              <Card key={String(label)}>
                <CardContent className="p-4">
                  <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
                  <p className={`text-2xl font-semibold tabular-nums ${cls}`}>{n}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {overdue.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-red-700 dark:text-red-300">
                  Overdue — entity filings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {overdue.map((r) => (
                  <ObligationCard key={r.id} row={r} today={today} onChanged={load} />
                ))}
              </CardContent>
            </Card>
          )}

          {upcoming.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Upcoming</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {upcoming.map((r) => (
                  <ObligationCard key={r.id} row={r} today={today} onChanged={load} />
                ))}
              </CardContent>
            </Card>
          )}

          {needsDate.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Applies, but no due date can be computed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  These depend on a date the entity profile does not have yet —
                  an anniversary-based deadline needs the qualification date.
                  Add it to <code>config/entity_profile.json</code> and re-run{" "}
                  <code>entity-calendar --apply</code>. No date is shown rather
                  than a guessed one.
                </p>
                {needsDate.map((r) => (
                  <ObligationCard key={r.id} row={r} today={today} onChanged={load} />
                ))}
              </CardContent>
            </Card>
          )}

          {settled.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Settled
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-4">State</th>
                        <th className="py-1 pr-4">Form</th>
                        <th className="py-1 pr-4">Period</th>
                        <th className="py-1 pr-4">Status</th>
                        <th className="py-1">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settled.map((r) => (
                        <tr key={r.id} className="border-t">
                          <td className="py-1 pr-4 font-medium">{r.state_code}</td>
                          <td className="py-1 pr-4">{r.form_code}</td>
                          <td className="py-1 pr-4">{r.period_label}</td>
                          <td className="py-1 pr-4">
                            <Badge variant="outline" className="text-[9px]">
                              {r.status.replace(/_/g, " ")}
                            </Badge>
                          </td>
                          <td className="py-1 text-muted-foreground">{r.user_notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <p className="text-[10px] text-muted-foreground">
        Monitoring aid — not legal or tax advice. Confidence describes how
        well-established each rule is; confirm anything material with a CPA.
        Contested positions (such as whether FBA inventory creates a California
        &ldquo;doing business&rdquo; obligation) are not scheduled here until
        confirmed in <code>config/entity_profile.json</code>.
      </p>
    </div>
  );
}
