"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Factory, Truck, Clock, Package } from "lucide-react";
import type { FourNumbersPlan } from "@/lib/inventory-four-numbers";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Portfolio four-number cards — shared across inventory / planning / pallets. */
export function FourNumbersSummary({
  plan,
  compact,
  planningHref = "/planning?tab=inbound",
}: {
  plan: FourNumbersPlan | null;
  compact?: boolean;
  planningHref?: string;
}) {
  if (!plan) return null;

  const phasedRows = plan.skuRows.filter((r) => r.fbaDosPhased != null);
  const avgPhasedDos =
    phasedRows.length > 0
      ? Math.round(
          phasedRows.reduce((s, r) => s + (r.fbaDosPhased ?? 0), 0) / phasedRows.length,
        )
      : null;

  const networkDates = plan.skuRows
    .map((r) => r.networkOosDate)
    .filter(Boolean) as string[];
  const earliestOos = networkDates.length ? networkDates.sort()[0] : null;

  if (compact) {
    return (
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 text-xs">
        <div>
          <span className="text-muted-foreground">Mfg </span>
          <span className="font-semibold tabular-nums">{fmt(plan.totalManufacture)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Ship </span>
          <span className="font-semibold tabular-nums">{fmt(plan.totalWarehouseShipFba)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">FBA DOS </span>
          <span className="font-semibold tabular-nums">{avgPhasedDos != null ? `${avgPhasedDos}d` : "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Net OOS </span>
          <span className="font-semibold">{earliestOos ?? "—"}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Shared supply math · phased demand · {plan.receivingDays}d warehouse→Prime
        </p>
        <Link href={planningHref} className="text-xs text-primary hover:underline">
          Supply detail →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-primary/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
              <Factory className="h-3.5 w-3.5" />
              1 · Manufacture
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{fmt(plan.totalManufacture)}</p>
            <p className="text-xs text-muted-foreground">Lip 6w · balm/deo 10w lead</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
              <Truck className="h-3.5 w-3.5" />
              2 · Warehouse ship
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmt(plan.totalWarehouseShipFba)}
              <span className="text-sm font-normal text-muted-foreground"> → FBA</span>
            </p>
            {plan.totalWarehouseShipAwd > 0 && (
              <p className="text-xs text-muted-foreground">
                + {fmt(plan.totalWarehouseShipAwd)} → AWD
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              3 · FBA DOS
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {avgPhasedDos != null ? `${avgPhasedDos}d avg` : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Phased · no new sends</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase text-muted-foreground">
              <Package className="h-3.5 w-3.5" />
              4 · Network OOS
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums">{earliestOos ?? "—"}</p>
            <p className="text-xs text-muted-foreground">FBA+AWD+3PL earliest</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
