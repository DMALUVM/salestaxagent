"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money, pct } from "@/lib/shopify-funnel";

/**
 * Thin Overview card — biggest leak + abandon $ + link to /shopper.
 * Mount-fetch is allowed: the route is a Supabase aggregate, not a Python shell.
 */
type Payload = {
  available: boolean;
  empty?: boolean;
  error?: string | null;
  setupHint?: string | null;
  conversionRate?: number | null;
  biggestLeak?: {
    fromLabel: string; toLabel: string; lost: number; rate: number | null;
  } | null;
  abandoned?: { open: number; openValue: number; recoveryRate: number | null };
  funnel?: { sessions: number | null; purchases: number | null };
  end?: string;
  status?: { missing_scopes?: string[]; last_synced_at?: string | null } | null;
};

export function ShopifyFunnelHealth() {
  const [d, setD] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 12_000);
    (async () => {
      try {
        const res = await fetch("/api/shopify-funnel?window=7&view=health", {
          signal: ctrl.signal,
          credentials: "same-origin",
        });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          throw new Error(`Unexpected ${res.status} response.`);
        }
        const payload = await res.json();
        if (!cancelled) setD(payload);
      } catch (e) {
        if (cancelled) return;
        const aborted = e instanceof Error && e.name === "AbortError";
        setD({
          available: false,
          error: aborted
            ? "Timed out talking to the warehouse."
            : e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const leak = d?.biggestLeak;
  const scopes = d?.status?.missing_scopes ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span>Shopper funnel · 7d</span>
          <Link href="/shopper" className="text-xs font-medium text-primary hover:underline">
            Drop-off + abandons
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!d && (
          <div className="h-12 animate-pulse rounded bg-muted" aria-busy="true" />
        )}
        {d && !d.available && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {d.error || "could not load"} — {d.setupHint || "Try again after the Mini sync."}
          </p>
        )}
        {d?.available && d.empty && (
          <p className="text-sm text-muted-foreground">
            Funnel not synced yet. {d.setupHint}
          </p>
        )}
        {d?.available && !d.empty && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Conversion
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {pct(d.conversionRate ?? null)}
              </p>
              <p className="text-xs text-muted-foreground">
                {d.funnel?.purchases ?? "—"} / {d.funnel?.sessions ?? "—"} sessions
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Biggest leak
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {leak ? `${leak.lost.toLocaleString()} lost` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {leak
                  ? `${leak.fromLabel} → ${leak.toLabel} · ${pct(leak.rate)}`
                  : "Closed-funnel counts missing"}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Open abandons
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {d.abandoned ? money(d.abandoned.openValue, 0) : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {d.abandoned?.open ?? "—"} carts
                {d.abandoned?.recoveryRate != null
                  ? ` · ${pct(d.abandoned.recoveryRate)} recovered`
                  : ""}
              </p>
            </div>
          </div>
        )}
        {scopes.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Shopify denied a query. Dave greenlit min READ scopes — grant{" "}
            {scopes.join(", ")} on Sales Tax Agent (no writes / theme / storefront).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
