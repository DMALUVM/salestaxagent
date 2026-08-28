"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { useInventory } from "@/lib/hooks";
import { displayTitle } from "@/lib/display-title";
import {
  latestOwnedSources,
  ownedNetworkTotalForSku,
} from "@/lib/inventory-owned-total";
import {
  EXAMPLE_FORMUNOVA_SKU,
  planProduction,
  type OptionalUnits,
} from "@/lib/production-planner-model";
import type {
  InventoryLeadtimeSummary,
  InventoryPlanning,
  InventoryRestock,
  InventorySettings,
  InventorySnapshot,
  SkuVelocity,
} from "@/lib/types";
import type { AmazonMonthlySale } from "@/lib/pallet-planner-model";
import { Shield } from "lucide-react";

function fmtQty(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
}

type SkuChoice = { sku: string; name: string };

function skuChoices(raw: Record<string, unknown> | null): SkuChoice[] {
  const names = new Map<string, string>();
  const skus = new Set<string>();
  const add = (sku?: string | null, name?: string | null) => {
    const key = String(sku ?? "").trim();
    if (!key || key === "UNKNOW" || key === "UNKNOWN") return;
    skus.add(key);
    if (name && !names.has(key)) names.set(key, displayTitle(name));
  };
  for (const v of (raw?.velocity ?? []) as SkuVelocity[]) add(v.sku, v.product_name);
  for (const s of (raw?.snapshots ?? []) as InventorySnapshot[]) add(s.sku, s.product_name);
  for (const t of (raw?.tpl ?? []) as Array<{ sku?: string; product_name?: string | null }>) {
    add(t.sku, t.product_name);
  }
  for (const a of (raw?.awd ?? []) as Array<{ sku?: string }>) add(a.sku, null);
  return [...skus]
    .sort((a, b) => a.localeCompare(b))
    .map((sku) => ({ sku, name: names.get(sku) ?? sku }));
}

export default function ProductionPlannerPage() {
  const configured = isConfigured();
  const { data: raw, loading } = useInventory();
  const choices = useMemo(() => skuChoices(raw), [raw]);
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("");
  const [available, setAvailable] = useState("");

  const selectedSku = sku || (choices.some((c) => c.sku === EXAMPLE_FORMUNOVA_SKU)
    ? EXAMPLE_FORMUNOVA_SKU
    : choices[0]?.sku ?? "");

  const plan = useMemo(() => {
    if (!raw || !selectedSku) return null;
    const snapshots = (raw.snapshots ?? []) as InventorySnapshot[];
    const tpl = (raw.tpl ?? []) as Array<{ sku: string; available: number; pulled_at?: string | null }>;
    const awd = (raw.awd ?? []) as Array<{ sku: string; awd_on_hand: number; pulled_at?: string | null }>;
    const restock = (raw.restock ?? []) as InventoryRestock[];
    const planning = (raw.planning ?? []) as InventoryPlanning[];
    const settings = (raw as { settings?: InventorySettings | null }).settings ?? null;
    const leadtime = (raw as { leadtime?: InventoryLeadtimeSummary | null }).leadtime ?? null;
    const sales = ((raw as { amazonLipSales?: AmazonMonthlySale[] }).amazonLipSales ?? []) as AmazonMonthlySale[];
    const velocities = (raw.velocity ?? []) as SkuVelocity[];
    const vel = velocities.find((v) => v.sku === selectedSku);
    const sources = latestOwnedSources({ snapshots, tpl, awd, restock, planning });
    const owned = ownedNetworkTotalForSku(selectedSku, sources);
    const daily: OptionalUnits = vel && vel.total_u_30 != null && !Number.isNaN(Number(vel.total_u_30))
      ? Number(vel.total_u_30)
      : null;
    const plannedQty = qty.trim() === "" ? null : Number(qty);
    const availableDate = available.trim() === "" ? null : available;
    const today = new Date();
    const asOf = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return planProduction({
      sku: selectedSku,
      productName: vel?.product_name ?? undefined,
      plannedQty: plannedQty != null && Number.isFinite(plannedQty) ? plannedQty : null,
      availableDate,
      asOf,
      onHand: {
        fba: owned.fbaOnHand,
        inbound: owned.fbaInbound,
        awd: owned.awdOnHand,
        tpl: owned.tplOnHand,
      },
      dailyVelocity: daily,
      monthlySales: sales,
      settings,
      leadtime,
    });
  }, [raw, selectedSku, qty, available]);

  if (!configured) return <SetupPrompt />;
  if (loading) return <LoadingState />;

  const selected = choices.find((c) => c.sku === selectedSku);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Production Planner</h1>
        <p className="text-sm text-muted-foreground">
          Recommend-only. Type a planned qty — nothing places a PO.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan one SKU</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <label htmlFor="pp-sku" className="text-xs font-medium">SKU</label>
            <Select
              id="pp-sku"
              className="mt-1 h-10"
              value={selectedSku}
              onChange={(e) => setSku(e.target.value)}
            >
              {choices.length === 0 && <option value="">No SKUs</option>}
              {choices.map((c) => (
                <option key={c.sku} value={c.sku}>
                  {c.name} · {c.sku}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <label htmlFor="pp-qty" className="text-xs font-medium">Planned production qty</label>
            <Input
              id="pp-qty"
              className="mt-1 h-10"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              placeholder="e.g. 2800"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="pp-date" className="text-xs font-medium">Available date</label>
            <Input
              id="pp-date"
              className="mt-1 h-10"
              type="date"
              value={available}
              onChange={(e) => setAvailable(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {selected ? `${selected.name} · ${selected.sku}` : "Recommendation"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Output label="Current OOS date" value={plan?.currentOosDate ?? "—"} />
            <Output label="New OOS date" value={plan?.newOosDate ?? "—"} />
            <Output label="Recommended next PO date" value={plan?.recommendedPoDate ?? "—"} />
            <Output label="Recommended next PO qty" value={fmtQty(plan?.recommendedPoQty ?? null)} />
          </div>
          {plan?.omittedLine && (
            <p className="text-xs text-muted-foreground">{plan.omittedLine}</p>
          )}
          {plan?.leadNote && (
            <p className="text-xs text-muted-foreground">{plan.leadNote}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Output({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
