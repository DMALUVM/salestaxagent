"use client";

import { useState } from "react";
import { DemandPlannerView } from "./DemandPlannerView";
import { InboundPlannerView } from "./InboundPlannerView";
import { FourNumbersSummary } from "./FourNumbersSummary";
import { useFourNumbersPlan } from "@/lib/use-four-numbers-plan";

export type PlanningTab = "demand" | "inbound";

export const PLANNING_TABS: Array<{ key: PlanningTab; label: string }> = [
  { key: "demand", label: "Demand" },
  { key: "inbound", label: "Supply" },
];

export function PlanningHub({ initialTab }: { initialTab: PlanningTab }) {
  const [tab, setTab] = useState<PlanningTab>(initialTab);
  const { plan, loading } = useFourNumbersPlan();

  function selectTab(next: PlanningTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Planning</h1>
        <div
          role="tablist"
          aria-label="Planning views"
          className="flex gap-1 rounded-md border p-0.5"
        >
          {PLANNING_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => selectTab(t.key)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                tab === t.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {!loading && plan && <FourNumbersSummary plan={plan} planningHref="/planning?tab=inbound" />}

      {tab === "demand" ? <DemandPlannerView /> : <InboundPlannerView plan={plan} />}
    </div>
  );
}
