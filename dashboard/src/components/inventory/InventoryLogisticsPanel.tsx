"use client";

import Link from "next/link";
import { ChevronRight, Package, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FourNumbersSummary } from "@/components/inventory/FourNumbersSummary";
import { useFourNumbersPlan } from "@/lib/use-four-numbers-plan";
import {
  buildInventoryActions,
  inventoryActionSummary,
  type InventoryAction,
} from "@/lib/inventory-actions";
import { useInventory } from "@/lib/hooks";
import { useState } from "react";

function ActionRow({ action }: { action: InventoryAction }) {
  const tone =
    action.severity === "critical"
      ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
      : action.severity === "investigate"
        ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
        : "border-border";

  return (
    <Link href={action.href}>
      <div
        className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/60 ${tone}`}
      >
        <div className="min-w-0">
          <p className="font-medium truncate">{action.label}</p>
          <p className="text-xs text-muted-foreground truncate">{action.detail}</p>
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </div>
    </Link>
  );
}

/** Solo-operator daily logistics — four numbers + priority actions. */
export function InventoryLogisticsPanel({
  compact,
  showSync,
}: {
  compact?: boolean;
  showSync?: boolean;
}) {
  const { data: raw, loading, refetch } = useInventory();
  const { plan } = useFourNumbersPlan({ raw });
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const actions = buildInventoryActions(raw, compact ? 5 : 8);
  const summary = inventoryActionSummary(raw);

  async function runSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/inventory-sync", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Sync failed");
      setSyncMsg(j.message || "Sync enqueued");
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  if (loading && !raw) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Loading inventory logistics…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={summary.critical > 0 ? "border-red-500/40" : summary.restock > 0 ? "border-amber-500/30" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Package className="h-4 w-4 text-orange-500" />
            Amazon logistics
          </CardTitle>
          <div className="flex items-center gap-2">
            {showSync && (
              <Button variant="outline" size="sm" disabled={syncing} onClick={runSync}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                Sync
              </Button>
            )}
            <Link href="/inventory" className="text-xs text-primary hover:underline">
              Inventory →
            </Link>
          </div>
        </div>
        {syncMsg && (
          <p className="text-[11px] text-muted-foreground">{syncMsg}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <FourNumbersSummary plan={plan} compact={compact} planningHref="/planning?tab=inbound" />

        <div className="flex flex-wrap gap-2 text-[11px]">
          {summary.critical > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
              {summary.critical} critical
            </span>
          )}
          {summary.restock > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {summary.restock} reorder
            </span>
          )}
          {summary.investigate > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-900 dark:bg-blue-950 dark:text-blue-200">
              {summary.investigate} rate check
            </span>
          )}
          {summary.critical === 0 && summary.restock === 0 && (
            <span className="text-muted-foreground">FBA cover OK</span>
          )}
        </div>

        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No urgent inventory actions.</p>
        ) : (
          <div className="space-y-2">
            {actions.map((a) => (
              <ActionRow key={`${a.sku}-${a.severity}`} action={a} />
            ))}
          </div>
        )}

        {!compact && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Link href="/planning?tab=inbound">
              <Button variant="outline" size="sm">Inbound waves</Button>
            </Link>
            <Link href="/inventory/pallets">
              <Button variant="outline" size="sm">Pallet planner</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              Refresh data
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
