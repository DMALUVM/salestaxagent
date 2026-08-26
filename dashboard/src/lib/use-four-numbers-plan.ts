"use client";

import { useMemo } from "react";
import { useInventory } from "@/lib/hooks";
import {
  buildFourNumbersPlanFromRaw,
  extractActiveSkus,
  DEFAULT_UNTIL_DATE,
  type InventoryRawLike,
} from "@/lib/inventory-supply-shared";
import type { FourNumbersPlan } from "@/lib/inventory-four-numbers";

export function useFourNumbersPlan(opts?: {
  skus?: string[];
  untilDate?: string;
  receivingDays?: number;
  raw?: InventoryRawLike | null;
}) {
  const { data: hookRaw, loading, error } = useInventory();
  const raw = opts?.raw ?? hookRaw;

  const plan = useMemo((): FourNumbersPlan | null => {
    if (!raw) return null;
    return buildFourNumbersPlanFromRaw(raw, {
      skus: opts?.skus,
      untilDate: opts?.untilDate ?? DEFAULT_UNTIL_DATE,
      receivingDays: opts?.receivingDays,
    });
  }, [raw, opts?.skus, opts?.untilDate, opts?.receivingDays]);

  const skuList = useMemo(() => {
    if (!raw) return opts?.skus ?? [];
    return opts?.skus ?? extractActiveSkus(raw);
  }, [raw, opts?.skus]);

  return {
    plan,
    loading: opts?.raw ? false : loading,
    error: opts?.raw ? null : error,
    raw,
    skuList,
  };
}
