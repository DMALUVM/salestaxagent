"use client";

import { useEffect, useState } from "react";
import { isConfigured } from "./supabase";

/**
 * Physical/inventory SKUs — those present in FBA snapshots, AWD, or 3PL.
 *
 * Lifted verbatim out of the Demand and Inbound planner pages, which each had
 * a byte-identical copy of this effect. Same endpoint, same union, same sort:
 * this is the SKU list both planners have always offered.
 */
export function useInventorySkus(): string[] {
  const [skuList, setSkuList] = useState<string[]>([]);

  useEffect(() => {
    if (!isConfigured()) return;
    fetch("/api/inventory").then((r) => r.json()).then((d) => {
      const invSkus = new Set<string>();
      for (const s of d.snapshots ?? []) if (s.sku) invSkus.add(s.sku);
      for (const s of d.awd ?? []) if (s.sku) invSkus.add(s.sku);
      for (const s of d.tpl ?? []) if (s.sku) invSkus.add(s.sku);
      setSkuList([...invSkus].sort());
    }).catch(() => {});
  }, []);

  return skuList;
}
