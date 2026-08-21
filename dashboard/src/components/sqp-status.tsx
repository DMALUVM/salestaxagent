"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Organic-rank (SQP) freshness card.
 *
 * Exists so the operator never needs a terminal to answer "is the PPC rank gate
 * working, and on what data?". Stale is shown as its own state, not as a
 * present-but-quiet number: rank older than the configured window gates as
 * UNKNOWN, so bids get held for manual checks rather than raised.
 */
interface Status {
  available: boolean;
  keywords?: number;
  bySource?: Record<string, number>;
  asins?: string[];
  newestAsOf?: string | null;
  oldestAsOf?: string | null;
  weeksStored?: number;
  weekEnds?: string[];
  ageDays?: number | null;
  stale?: boolean;
  setupHint?: string | null;
  error?: string | null;
  gating?: { enabled: boolean; staleAfterDays: number; highBidThreshold: number };
  sqpAuto?: {
    enabled?: boolean;
    asins?: string[];
    report_period?: string;
    schedule?: { day_of_week?: string; hour?: number; minute?: number; timezone?: string };
  } | null;
}

export function SqpStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    fetch("/api/sqp-status").then((r) => r.json()).then(setS).catch(() => setS(null));
  }
  useEffect(load, []);

  async function syncNow() {
    setBusy(true);
    setMsg("Requesting the report from Amazon — this can take a few minutes…");
    try {
      const r = await fetch("/api/sqp-sync", { method: "POST" }).then((x) => x.json());
      setMsg(r.ok ? (r.output ?? "Done.") : (r.hint ?? r.error ?? "Failed."));
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;

  const sched = s.sqpAuto?.schedule;
  const schedText = sched
    ? `${sched.day_of_week ?? "mon"} ${String(sched.hour ?? 10).padStart(2, "0")}:${String(sched.minute ?? 0).padStart(2, "0")} ${sched.timezone ?? ""}`
    : "not scheduled";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Organic rank data (Brand Analytics SQP)
          </CardTitle>
          <Button variant="outline" size="sm" className="text-xs"
                  disabled={busy} onClick={syncNow}>
            {busy ? "Syncing…" : "Sync SQP now"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {!s.available ? (
          <p className="text-xs text-muted-foreground">
            {s.setupHint ?? s.error ?? "No organic-rank table yet."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={`text-[9px] ${
                  s.stale
                    ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                    : "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900"
                }`}
                title={
                  s.stale
                    ? `Older than ${s.gating?.staleAfterDays ?? 14} days — the gate treats this as UNKNOWN and holds high bids for a manual check.`
                    : "Fresh enough to gate bid increases."
                }
              >
                {s.stale ? "stale — gating as unknown" : "fresh"}
              </Badge>
              <span className="text-xs tabular-nums">
                {s.keywords?.toLocaleString() ?? 0} keywords
              </span>
              {s.newestAsOf && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  newest {s.newestAsOf}
                  {s.ageDays !== null && s.ageDays !== undefined ? ` (${s.ageDays}d ago)` : ""}
                </span>
              )}
            </div>

            {(s.weeksStored ?? 0) > 0 && (
              <p className="text-[10px] text-muted-foreground">
                <span className="font-medium">{s.weeksStored}</span> week
                {s.weeksStored === 1 ? "" : "s"} stored
                {s.oldestAsOf && s.newestAsOf
                  ? ` (${s.oldestAsOf} → ${s.newestAsOf})`
                  : ""}
                {(s.weeksStored ?? 0) < 8 && (
                  <>
                    {" "}— trends need more history. Run{" "}
                    <code>sqp-backfill --max-weeks 4 --apply</code> on the agent,
                    about 4 weeks/day; SQP quota is tight so there is no
                    one-click bulk load.
                  </>
                )}
              </p>
            )}

            <p className="text-[10px] text-muted-foreground">
              sources: {Object.entries(s.bySource ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}
              {s.asins?.length ? ` · ASINs covered: ${s.asins.join(", ")}` : ""}
            </p>
          </>
        )}

        <p className="text-[10px] text-muted-foreground">
          Weekly schedule: {schedText}
          {s.sqpAuto?.report_period ? ` · period ${s.sqpAuto.report_period}` : ""}
          {s.sqpAuto?.asins?.length ? ` · ${s.sqpAuto.asins.length} ASIN(s) configured` : ""}
        </p>
        <p className="text-[10px] text-muted-foreground">
          SQP reports click/impression <span className="font-medium">share</span>,
          not SERP position — rank is a derived band used to restrain bid
          increases only. Never blocks negatives, pauses or bid cuts.
        </p>
        {msg && (
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-[10px]">{msg}</pre>
        )}
      </CardContent>
    </Card>
  );
}
