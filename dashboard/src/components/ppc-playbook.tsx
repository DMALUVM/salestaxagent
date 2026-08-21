"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * This week's decisions, in order.
 *
 * Deliberately opinionated about sequence: waste is cut before growth is
 * funded. A bid raise on a losing placement compounds the loss, and negatives
 * and placement cuts are reversible in a way a bidding war is not.
 */
const TONE: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900",
  P1: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  P2: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  P3: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

interface Item { priority: string; title: string; why: string; do: string }

/** The CLI is the single source of truth, so its text output is parsed. */
function parse(text: string): { items: Item[]; cadence: string[]; header: string[] } {
  const lines = text.split("\n");
  const items: Item[] = [];
  const cadence: string[] = [];
  const header: string[] = [];
  let cur: Item | null = null;
  let inCadence = false;

  for (const raw of lines) {
    const l = raw.trim();
    if (/^Weekly cadence:/.test(l)) { inCadence = true; continue; }
    if (inCadence) {
      if (l.startsWith("•")) cadence.push(l.replace(/^•\s*/, ""));
      continue;
    }
    const m = l.match(/^\[(P[0-3])\]\s+(.*)$/);
    if (m) {
      if (cur) items.push(cur);
      cur = { priority: m[1], title: m[2], why: "", do: "" };
      continue;
    }
    if (cur && l.startsWith("WHY :")) cur.why = l.slice(5).trim();
    else if (cur && l.startsWith("DO  :")) cur.do = l.slice(5).trim();
    else if (!cur && l && !l.startsWith("PPC playbook")) header.push(l);
  }
  if (cur) items.push(cur);
  return { items, cadence, header };
}

export function PpcPlaybook() {
  const [state, setState] = useState<{ text: string; error?: string } | null>(null);

  useEffect(() => {
    fetch("/api/ppc-playbook")
      .then((r) => r.json())
      .then((d) => setState({ text: d.text ?? "", error: d.available ? undefined : (d.hint ?? d.error) }))
      .catch(() => setState({ text: "", error: "Could not load the playbook." }));
  }, []);

  if (!state) return null;
  const { items, cadence, header } = parse(state.text);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          This week&apos;s playbook
          <span className="ml-2 font-normal text-muted-foreground">
            waste first, growth last
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.error && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{state.error}</p>
        )}
        {header.length > 0 && (
          <p className="text-[10px] text-muted-foreground">{header.join(" · ")}</p>
        )}

        {items.map((it, i) => (
          <div key={i} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={`text-[9px] ${TONE[it.priority] ?? ""}`}>
                {it.priority}
              </Badge>
              <span className="text-xs font-medium">{it.title}</span>
            </div>
            {it.why && <p className="mt-1 text-[10px] text-muted-foreground">{it.why}</p>}
            {it.do && (
              <p className="mt-1 text-[11px]">
                <span className="font-medium">Do:</span> {it.do}
              </p>
            )}
          </div>
        ))}

        {items.length === 0 && !state.error && (
          <p className="text-xs text-muted-foreground">Nothing actionable right now.</p>
        )}

        {cadence.length > 0 && (
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">
              Weekly cadence
            </p>
            <ol className="list-decimal space-y-0.5 pl-4">
              {cadence.map((c, i) => (
                <li key={i} className="text-[10px] text-muted-foreground">{c}</li>
              ))}
            </ol>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          Brand terms are capped, never scaled — including the pre-2025-10-31
          &ldquo;Dr. Dave&apos;s Primal Essence&rdquo; era, which counts as brand
          on the same ASINs. Multi-week SQP drives trend and the rank gate; it is
          the ASIN view, not Brand View category parity.
        </p>
      </CardContent>
    </Card>
  );
}
