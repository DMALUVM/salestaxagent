"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EMPTY_STATE_COPY, RT_EMPTY_COPY, type SoldScopeHero } from "@/lib/soldscope-status";

/**
 * Thin SoldScope research stub on /ppc.
 *
 * Warehouse freshness only — never a second sales, ads, or BSR chart.
 * Empty is the expected state until SoldScope finishes Dave's catalog
 * download and the Sunday job stores real points.
 */
type Payload = {
  available?: boolean;
  empty?: boolean;
  stored?: boolean;
  newestDate?: string | null;
  counts?: { sales?: number; bsr?: number; price?: number; rank?: number };
  heroes?: SoldScopeHero[];
  lastJob?: { status?: string; started_at?: string; message?: string } | null;
  setupHint?: string | null;
  emptyCopy?: string;
  rankTrackerCopy?: string;
  error?: string | null;
};

export function SoldScopeCard() {
  const [s, setS] = useState<Payload | null>(null);

  useEffect(() => {
    fetch("/api/soldscope")
      .then((r) => r.json())
      .then(setS)
      .catch(() => setS({ available: false, empty: true, error: "Could not load SoldScope status" }));
  }, []);

  const empty = s?.empty !== false;
  const jobStatus = s?.lastJob?.status;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          SoldScope research
          <Badge variant="outline" className="text-[10px] font-normal">
            observe-only
          </Badge>
          {empty ? (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              waiting
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] font-normal">
              stored
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-muted-foreground">
        <p>
          Additive Amazon intel for the three parent heroes. Not Pulse, not Ads,
          not a second sales or BSR chart.
        </p>
        <p className="tabular-nums">
          {(s?.heroes ?? []).map((h) => `${h.title} (${h.asin})`).join(" · ")
            || "Lip Balm 3pk · Tallow Balm · Tallow Deodorant"}
        </p>
        {empty ? (
          <p>{s?.emptyCopy ?? EMPTY_STATE_COPY}</p>
        ) : (
          <p className="tabular-nums">
            Research warehouse has rows
            {s?.newestDate ? ` (newest ${s.newestDate})` : ""}.
            {" "}Open SoldScope or query soldscope_* — this card does not re-plot them.
          </p>
        )}
        <p>{s?.rankTrackerCopy ?? RT_EMPTY_COPY}</p>
        {s?.lastJob && (
          <p className="tabular-nums">
            Last weekly job: {jobStatus ?? "?"}
            {s.lastJob.started_at ? ` · ${String(s.lastJob.started_at).slice(0, 16)}` : ""}
          </p>
        )}
        {s?.setupHint && <p>{s.setupHint}</p>}
        {s?.error && <p className="text-red-600 dark:text-red-400">{s.error}</p>}
      </CardContent>
    </Card>
  );
}
