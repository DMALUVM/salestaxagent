"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { FreshnessSummary } from "@/lib/data-freshness";

function fmtDay(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Compact "Data as of …" strip for the main layout.
 * Fail-soft: a missing API must never block the rest of the dashboard.
 */
export function DataFreshnessStrip() {
  const [info, setInfo] = useState<FreshnessSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/data-freshness")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && !d.error) setInfo(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;

  return (
    <div className="border-b bg-card/70 px-4 py-1.5 text-[11px] text-muted-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Data as of{" "}
          <span className="font-medium text-foreground">{fmtDay(info.asOf)}</span>
        </span>
        <span className="hidden sm:inline" aria-hidden>
          ·
        </span>
        <span>
          Shopify{" "}
          <span className={info.shopifyStale ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
            {fmtDay(info.shopifyMax)}
          </span>
        </span>
        <span>
          Amazon{" "}
          <span className={info.amazonStale ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
            {fmtDay(info.amazonMax)}
          </span>
        </span>
        {info.stale && (
          <span className="text-amber-600 dark:text-amber-400">Stale (&gt;36h)</span>
        )}
        <Link href="/data" className="ml-auto font-medium text-primary hover:underline">
          Data
        </Link>
      </div>
    </div>
  );
}
