"use client";

import { useEffect, useState } from "react";
import { persistSkuNotSelling } from "@/lib/inventory-sku-flags";

/** Persistable "not selling" checkbox. Overview-alert hide only. */
export function NotSellingToggle({
  sku,
  checked,
  onChanged,
}: {
  sku: string;
  checked: boolean;
  onChanged?: () => void;
}) {
  const [value, setValue] = useState(checked);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setValue(checked);
    setErr(null);
  }, [checked, sku]);

  async function onToggle() {
    if (!sku) return;
    const next = !value;
    setValue(next);
    setSaving(true);
    setErr(null);
    try {
      await persistSkuNotSelling(sku, next);
      onChanged?.();
    } catch (e) {
      setValue(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value}
          disabled={saving || !sku}
          onChange={onToggle}
        />
        Not selling
      </label>
      <p className="text-[10px] text-muted-foreground">
        Hide from Overview critical / reorder / rate-check. Inventory data stays.
      </p>
      {err && (
        <p className="text-[10px] text-red-600" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
