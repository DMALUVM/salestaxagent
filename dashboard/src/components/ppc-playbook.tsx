"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle, X } from "lucide-react";
import {
  PLAYBOOK_TOP_N, topNPlaybook, type PlaybookItem, type PlaybookRec,
  type PlaybookPlacement, type PlaybookRole,
} from "@/lib/ppc-playbook";

/**
 * This week's Top-N decisions, in order.
 *
 * Ranked from data already on the page (recs + placements + roles) so Vercel
 * never has to shell out to Python. The optional CLI button is the original
 * on-demand playbook — kept as a reversible extra, not the primary view.
 *
 * Sequence is the opinion: waste is cut before growth is funded.
 */
const TONE: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900",
  P1: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  P2: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  P3: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

interface CliItem { priority: string; title: string; why: string; do: string }

function parseCli(text: string): { items: CliItem[]; cadence: string[]; header: string[] } {
  const lines = text.split("\n");
  const items: CliItem[] = [];
  const cadence: string[] = [];
  const header: string[] = [];
  let cur: CliItem | null = null;
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

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function PpcPlaybook({
  recs = [],
  placements = [],
  roles = [],
  targetAcos = 30,
  onMark,
}: {
  recs?: PlaybookRec[];
  placements?: PlaybookPlacement[];
  roles?: PlaybookRole[];
  targetAcos?: number;
  onMark?: (id: string, status: "applied" | "dismissed") => void;
}) {
  const [cli, setCli] = useState<{ text: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const items = topNPlaybook(targetAcos, recs, placements, roles, PLAYBOOK_TOP_N);

  async function loadCli() {
    setBusy(true);
    try {
      const res = await fetch("/api/ppc-playbook");
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Unexpected ${res.status} response from the playbook route.`);
      }
      const d = await res.json();
      setCli({ text: d.text ?? "", error: d.available ? undefined : (d.hint ?? d.error) });
    } catch (e) {
      setCli({ text: "", error: e instanceof Error ? e.message : "Could not load the playbook." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="ppc-playbook" className="scroll-mt-14 border-amber-500/30">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            This week&apos;s Top {PLAYBOOK_TOP_N}
            <span className="ml-2 font-normal text-muted-foreground">
              cut waste → fix placements → scale only where rank supports
            </span>
          </CardTitle>
          <Button variant="outline" size="sm" className="text-xs"
                  disabled={busy} onClick={loadCli}>
            {busy ? "Building CLI…" : cli ? "Refresh CLI playbook" : "CLI playbook"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[10px] text-muted-foreground">
          Ranked from the live Actions queue and placement KPIs already on this
          page — same recommendations, first {PLAYBOOK_TOP_N} only. The full
          list stays in the Actions tab. Nothing is auto-applied; nothing writes
          to Amazon.
        </p>

        {items.map((it, i) => (
          <PlaybookRow key={`${it.recId ?? it.title}-${i}`} index={i + 1} item={it} onMark={onMark} />
        ))}

        {items.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing in the Top {PLAYBOOK_TOP_N} yet — generate recommendations
            after an Ads sync, or wait for the 06:00 ads_actions job.
          </p>
        )}

        {cli && <CliExtra state={cli} />}

        <p className="text-[10px] text-muted-foreground">
          Brand terms are capped, never scaled — including the pre-2025-10-31
          &ldquo;Dr. Dave&apos;s Primal Essence&rdquo; era, which counts as brand
          on the same ASINs. Rank-blocked raises are held out of this list on
          purpose. Multi-week SQP drives trend and the rank gate; it is the
          ASIN view, not Brand View category parity.
        </p>
      </CardContent>
    </Card>
  );
}

function PlaybookRow({
  index, item, onMark,
}: {
  index: number; item: PlaybookItem;
  onMark?: (id: string, status: "applied" | "dismissed") => void;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] tabular-nums text-muted-foreground w-4">{index}</span>
        <Badge variant="outline" className={`text-[9px] ${TONE[item.priority] ?? ""}`}>
          {item.priority}
        </Badge>
        <span className="text-xs font-medium">{item.title}</span>
        {item.impact > 0 && (
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {money(item.impact)} at stake
          </span>
        )}
      </div>
      {item.why && <p className="mt-1 text-[10px] text-muted-foreground">{item.why}</p>}
      {item.do && (
        <p className="mt-1 text-[11px]">
          <span className="font-medium">Do:</span> {item.do}
        </p>
      )}
      {item.recId && onMark && (
        <div className="mt-2 flex gap-1">
          <Button variant="outline" size="sm" className="h-6 text-[10px]"
                  onClick={() => onMark(item.recId!, "applied")}>
            <CheckCircle className="mr-1 h-3 w-3 text-emerald-500" />
            Mark applied
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-[10px]"
                  onClick={() => onMark(item.recId!, "dismissed")}>
            <X className="mr-1 h-3 w-3" />
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function CliExtra({ state }: { state: { text: string; error?: string } }) {
  const { items, cadence, header } = parseCli(state.text);
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-[10px] uppercase text-muted-foreground">CLI playbook (agent)</p>
      {state.error && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{state.error}</p>
      )}
      {header.length > 0 && (
        <p className="text-[10px] text-muted-foreground">{header.join(" · ")}</p>
      )}
      {items.map((it, i) => (
        <div key={i} className="text-[11px]">
          <Badge variant="outline" className={`mr-1 text-[9px] ${TONE[it.priority] ?? ""}`}>
            {it.priority}
          </Badge>
          {it.title}
        </div>
      ))}
      {cadence.length > 0 && (
        <ol className="list-decimal space-y-0.5 pl-4">
          {cadence.map((c, i) => (
            <li key={i} className="text-[10px] text-muted-foreground">{c}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
