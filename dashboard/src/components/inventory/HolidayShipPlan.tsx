"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  InventoryLeadtimeSummary,
  InventoryPlanning,
  InventoryRestock,
  InventorySettings,
  InventorySnapshot,
} from "@/lib/types";
import {
  AUGUST_HOP_DESTINATION,
  AUGUST_HOP_LABEL,
  FAMILY_FBA_CAP_OCT_DEC,
  FAMILY_FBA_CAP_PEAK,
  LIP_BALM_SKUS,
  FIRST_WAVE_AWD_TARGETS,
  FIRST_WAVE_AWD_TARGET_CAP,
  OPTIMISTIC_AWD_ON_HAND_TARGETS,
  OPTIMISTIC_AWD_TARGET_CAP,
  PALLET_MAX_UNITS,
  palletPartialMinUnits,
  buildMonthViewEntries,
  buildSeptemberPlan,
  familyFbaCapForMonth,
  fbaCoverUnits,
  inboundInTransit,
  latestRowPerSku,
  plannerPolicy,
  productionHorizonMonths,
  stampDate,
  type MonthViewEntry,
} from "@/lib/pallet-planner-model";

const SKU_SHORT: Record<string, string> = {
  DDPE0001Shop: "Unscented",
  DDPE0002Shop: "Peppermint",
  DDPE0003Shop: "Orange",
  DDPE0004Shop: "Assorted",
};
const FIRST_ACTION_SKUS = ["DDPE0004Shop", "DDPE0003Shop", "DDPE0002Shop", "DDPE0001Shop"] as const;

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function HolidayShipPlan({
  compact,
  snapshots,
  awdList,
  tplList,
  restockList,
  planningList,
  settings,
  leadtime,
}: {
  compact?: boolean;
  snapshots: InventorySnapshot[];
  awdList: { sku: string; awd_on_hand: number; pulled_at?: string | null }[];
  tplList: { sku: string; available: number; pulled_at?: string | null }[];
  restockList?: InventoryRestock[];
  planningList?: InventoryPlanning[];
  settings?: InventorySettings | null;
  leadtime?: InventoryLeadtimeSummary | null;
}) {
  const [committed, setCommitted] = useState<Set<string>>(new Set());
  const [augustQty, setAugustQty] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pallet_committed_months");
      if (saved) setCommitted(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
    try {
      const saved = localStorage.getItem("pallet_august_qty");
      if (saved) setAugustQty(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  const setAugust = useCallback((sku: string, value: string) => {
    setAugustQty((prev) => {
      const next = { ...prev, [sku]: value };
      localStorage.setItem("pallet_august_qty", JSON.stringify(next));
      return next;
    });
  }, []);

  const policy = useMemo(() => plannerPolicy(settings, leadtime), [settings, leadtime]);
  const latestTpl = useMemo(() => latestRowPerSku(tplList), [tplList]);

  const parsedAugust = useMemo(() => {
    const out: Record<string, number> = {};
    for (const sku of LIP_BALM_SKUS) {
      const n = parseInt(augustQty[sku] ?? "", 10);
      out[sku] = Number.isFinite(n) && n > 0 ? n : 0;
    }
    return out;
  }, [augustQty]);

  const latestRestock = useMemo(() => latestRowPerSku(restockList ?? []), [restockList]);
  const latestPlanning = useMemo(() => latestRowPerSku(planningList ?? []), [planningList]);

  const { sept, entries, fbaPlusInbound } = useMemo(() => {
    const snapMap = new Map(snapshots.map((s) => [s.sku, s]));
    const awdMap = new Map(awdList.map((a) => [a.sku, a]));
    const tplMap = new Map(latestTpl.map((t) => [t.sku, t]));
    const restockMap = new Map(latestRestock.map((r) => [r.sku, r]));
    const planningMap = new Map(latestPlanning.map((p) => [p.sku, p]));
    const skuFba: Record<string, number> = {};
    const skuInbound: Record<string, number> = {};
    const sku3pl: Record<string, number> = {};
    const skuAwd: Record<string, number> = {};
    let ohInb = 0;
    for (const sku of LIP_BALM_SKUS) {
      const snap = snapMap.get(sku) ?? {};
      skuFba[sku] = fbaCoverUnits(snap, restockMap.get(sku)?.raw, planningMap.get(sku)?.raw);
      skuInbound[sku] = inboundInTransit(snap);
      sku3pl[sku] = Number(tplMap.get(sku)?.available ?? 0);
      skuAwd[sku] = Number(awdMap.get(sku)?.awd_on_hand ?? 0);
      ohInb += skuFba[sku] + skuInbound[sku];
    }
    const plan = buildSeptemberPlan(
      skuFba, skuInbound, sku3pl, {}, parsedAugust, skuAwd,
      { receiveDays: policy.gateReceiveDays, tulsaFloor: policy.tulsaFloorUnits },
    );
    const months = productionHorizonMonths(
      new Date(), undefined, policy.gateReceiveDays, policy.peakEndDate, policy.refillReceiveDays,
    );
    return {
      sept: plan,
      entries: buildMonthViewEntries({
        productionMonths: months.map((h) => h.month),
        horizonByMonth: Object.fromEntries(months.map((h) => [h.month, h])),
        sept: plan,
        skuAugust: parsedAugust,
        committed,
      }),
      fbaPlusInbound: ohInb,
    };
  }, [snapshots, awdList, latestTpl, latestRestock, latestPlanning, parsedAugust, policy, committed]);

  const fbaAsOf = stampDate(snapshots.find((s) => s.snapshot_at)?.snapshot_at);
  const awdAsOf = stampDate(awdList.find((a) => a.pulled_at)?.pulled_at);
  const tplAsOf = stampDate(latestTpl.find((t) => t.pulled_at)?.pulled_at);
  const afterTonight = sept.firstAction.fbaAfterSendTotal;
  const tulsaHold = sept.firstAction.tulsaHoldTotal;
  const sendTotal = sept.firstAction.tplToFbaTotal;
  const overCap = afterTonight > FAMILY_FBA_CAP_PEAK;

  const firstAction = (
    <Card className="border-blue-500/50 bg-blue-500/5">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Badge>NEXT HOP</Badge>
          <CardTitle className="text-sm font-medium">August · 3PL→FBA {fmt(sendTotal)}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm font-semibold tabular-nums">
          {FIRST_ACTION_SKUS.filter((sku) => (sept.tplToFba[sku] ?? 0) > 0).map((sku, i) => {
            const qty = sept.tplToFba[sku] ?? 0;
            return (
              <span key={sku}>
                {i > 0 ? " / " : ""}
                {fmt(qty)} {SKU_SHORT[sku].toLowerCase()}
              </span>
            );
          })}
        </p>
        <p className="text-sm">
          Tulsa hold {fmt(tulsaHold)}. Inbound already counted — do not re-send.
        </p>
        <p className="text-[11px] text-muted-foreground">
          Fee-safe on 270-unit / 13×11×9 boxes. Not a 40k FBA manufacture buy.
        </p>
      </CardContent>
    </Card>
  );

  const capCard = (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">FBA cap vs on-hand + inbound</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="tabular-nums">
          Sep {fmt(familyFbaCapForMonth("2026-09"))} · on-hand+inbound {fmt(fbaPlusInbound)}
          {" · after tonight "}{fmt(afterTonight)}
        </p>
        <p className="tabular-nums text-muted-foreground">
          Oct–Dec ~{fmt(FAMILY_FBA_CAP_OCT_DEC)} · never over cap
        </p>
        {overCap && (
          <p className="text-xs text-red-500">After tonight exceeds the Sep cap — do not add more FBA.</p>
        )}
      </CardContent>
    </Card>
  );

  const firstWaveCard = (
    <Card className="border-emerald-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">First-wave AWD {fmt(FIRST_WAVE_AWD_TARGET_CAP)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>Locked after FBA is maxed. New Marpac single-SKU → AWD. Not from Tulsa after tonight.</p>
        <p className="tabular-nums">
          Assorted {fmt(FIRST_WAVE_AWD_TARGETS.DDPE0004Shop)}
          {" · "}Orange {fmt(FIRST_WAVE_AWD_TARGETS.DDPE0003Shop)}
          {" · "}Unscented {fmt(FIRST_WAVE_AWD_TARGETS.DDPE0001Shop)}
          {" · "}Peppermint {fmt(FIRST_WAVE_AWD_TARGETS.DDPE0002Shop)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Assorted + orange target end of September (2 pallets/month max), then unscented + peppermint.
        </p>
      </CardContent>
    </Card>
  );

  const awdCard = (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">AWD high water {fmt(OPTIMISTIC_AWD_TARGET_CAP)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>Optimistic context — not the near-term manufacture/buy.</p>
        <p className="tabular-nums text-muted-foreground">
          Orange {fmt(OPTIMISTIC_AWD_ON_HAND_TARGETS.DDPE0003Shop)}
          {" · "}Unscented {fmt(OPTIMISTIC_AWD_ON_HAND_TARGETS.DDPE0001Shop)}
          {" · "}Assorted {fmt(OPTIMISTIC_AWD_ON_HAND_TARGETS.DDPE0004Shop)}
          {" · "}Peppermint {fmt(OPTIMISTIC_AWD_ON_HAND_TARGETS.DDPE0002Shop)}
        </p>
      </CardContent>
    </Card>
  );

  const asOf = (
    <p className="text-[11px] text-muted-foreground">
      As-of: FBA {fbaAsOf ?? "—"}
      {awdAsOf ? ` · AWD ${awdAsOf}` : ""}
      {tplAsOf ? ` · 3PL ${tplAsOf}` : ""}
    </p>
  );

  if (compact) {
    return (
      <div className="space-y-3">
        {asOf}
        {firstAction}
        <div className="grid gap-3 sm:grid-cols-2">
          {firstWaveCard}
          {capCard}
        </div>
        <Link href="/inventory/pallets">
          <Button variant="outline" size="sm">Month cards → Pallet Planner</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {asOf}
      {firstAction}

      <div>
        <p className="text-sm font-medium mb-2">Month cards</p>
        <p className="text-[11px] text-muted-foreground mb-3">
          First wave: assorted + orange end of September, then unscented + peppermint (2 AWD cards/month max).
          Not the {fmt(OPTIMISTIC_AWD_TARGET_CAP)} high water.
          Each full AWD card is {fmt(PALLET_MAX_UNITS)}; partial ≥{fmt(palletPartialMinUnits())}.
          {" "}August: Marpac→Tulsa TBD and 3PL→FBA 12,960.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {entries
            .filter((e) => e.units > 0 || e.awaitingAugustTotals || e.month.endsWith("-08"))
            .map((entry, idx) => (
            <MonthCard
              key={`${entry.month}-${entry.destination}-${entry.track}-${idx}`}
              entry={entry}
              augustQty={augustQty}
              setAugust={setAugust}
            />
          ))}
        </div>
      </div>

      {firstWaveCard}
      {capCard}
      {awdCard}
    </div>
  );
}

function MonthCard({
  entry,
  augustQty,
  setAugust,
}: {
  entry: MonthViewEntry;
  augustQty: Record<string, string>;
  setAugust: (sku: string, value: string) => void;
}) {
  const destLabel = entry.hopLabel
    || (entry.destination === "3pl_fba"
      ? "3PL→FBA"
      : entry.destination === "awd"
        ? "single-SKU AWD"
        : entry.destination === AUGUST_HOP_DESTINATION || entry.awaitingAugustTotals
          ? AUGUST_HOP_LABEL
          : null);
  const isMarpacTulsa = entry.destination === AUGUST_HOP_DESTINATION
    || entry.awaitingAugustTotals;
  const partialMin = palletPartialMinUnits();

  return (
    <div
      className={`rounded-lg border p-4 ${
        entry.nextHop ? "border-blue-500/50 bg-blue-500/5" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="font-medium text-sm">{entry.label}</p>
        <div className="flex flex-wrap gap-1">
          {entry.nextHop && <Badge className="text-[10px]">NEXT HOP</Badge>}
          {destLabel && <Badge variant="outline" className="text-[10px]">{destLabel}</Badge>}
        </div>
      </div>

      {isMarpacTulsa && entry.units === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Marpac→Tulsa · mix TBD — do not invent a mix.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {LIP_BALM_SKUS.map((sku) => (
              <label key={sku} className="text-[10px] text-muted-foreground">
                {SKU_SHORT[sku]}
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="TBD"
                  value={augustQty[sku] ?? ""}
                  onChange={(e) => setAugust(sku, e.target.value)}
                  className="mt-0.5 w-full rounded border bg-background px-1.5 py-0.5 text-right text-xs tabular-nums"
                  aria-label={`${SKU_SHORT[sku]} August qty`}
                />
              </label>
            ))}
          </div>
        </div>
      ) : entry.units === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          {entry.destination === "awd" ? "No single-SKU AWD this month" : "No movement this month"}
        </p>
      ) : entry.destination === "3pl_fba" ? (
        <>
          <p className="text-2xl font-semibold tabular-nums">{fmt(entry.units)}</p>
          <p className="text-[10px] text-muted-foreground mb-2">3PL→FBA · not a Marpac pallet</p>
          <SkuLines mix={entry.mix} />
        </>
      ) : (
        <>
          {entry.isPalletCard ? (
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-2xl font-semibold tabular-nums">{fmt(entry.units)}</span>
              <span className="text-xs text-muted-foreground">
                {entry.hasPartial && (entry.fullPallets ?? 0) > 0
                  ? `${entry.fullPallets} full + 1 partial (${fmt(entry.partialUnits ?? 0)})`
                  : entry.hasPartial
                    ? `partial ≥${fmt(partialMin)}`
                    : `${entry.fullPallets ?? entry.pallets} full pallet`}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Held leftover — not a card</p>
          )}
          <SkuLines mix={entry.mix} />
          {entry.destination === "awd" && entry.units > 0 && entry.units < partialMin && (
            <p className="text-[10px] text-amber-600 mt-1">AWD cards must be ≥{fmt(partialMin)}</p>
          )}
        </>
      )}
    </div>
  );
}

function SkuLines({ mix }: { mix: Record<string, number> }) {
  return (
    <div className="space-y-1">
      {LIP_BALM_SKUS.map((sku) => {
        const qty = mix[sku];
        if (!qty || qty <= 0) return null;
        return (
          <div key={sku} className="flex justify-between text-xs">
            <span className="text-muted-foreground">{SKU_SHORT[sku]}</span>
            <span className="tabular-nums font-medium">{fmt(qty)}</span>
          </div>
        );
      })}
    </div>
  );
}
