"use client";

import { useInventory } from "@/lib/hooks";
import type {
  InventoryLeadtimeSummary,
  InventoryPlanning,
  InventoryRestock,
  InventorySettings,
  InventorySnapshot,
} from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { isConfigured } from "@/lib/supabase";
import { Shield } from "lucide-react";
import Link from "next/link";
import { HolidayShipPlan } from "@/components/inventory/HolidayShipPlan";
import { latestRowPerSku } from "@/lib/pallet-planner-model";

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
}

export default function PalletPlanPage() {
  const configured = isConfigured();
  const { data: raw, loading } = useInventory();

  if (!configured) return <SetupPrompt />;
  if (loading) return <LoadingState />;

  const snapshots = (raw?.snapshots ?? []) as InventorySnapshot[];
  const awdList = (raw?.awd ?? []) as { sku: string; awd_on_hand: number; pulled_at?: string | null }[];
  const tplList = latestRowPerSku((raw?.tpl ?? []) as { sku: string; available: number; pulled_at?: string | null }[]);
  const restockList = (raw?.restock ?? []) as InventoryRestock[];
  const planningList = (raw?.planning ?? []) as InventoryPlanning[];
  const settings = (raw as { settings?: InventorySettings | null } | undefined)?.settings;
  const leadtime = (raw as { leadtime?: InventoryLeadtimeSummary | null } | undefined)?.leadtime;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pallet Planner</h1>
          <p className="text-sm text-muted-foreground">What we use to ship. First action is September 3PL→FBA 8,100 + 3PL→AWD 2,700.</p>
        </div>
        <Link href="/inventory"><Button variant="outline" size="sm">← Inventory</Button></Link>
      </div>
      <HolidayShipPlan
        snapshots={snapshots}
        awdList={awdList}
        tplList={tplList}
        restockList={restockList}
        planningList={planningList}
        settings={settings}
        leadtime={leadtime}
      />
    </div>
  );
}
