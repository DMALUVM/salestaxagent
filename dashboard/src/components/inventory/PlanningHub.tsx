"use client";

import { useState } from "react";
import { DemandPlannerView } from "./DemandPlannerView";
import { InboundPlannerView } from "./InboundPlannerView";

export type PlanningTab = "demand" | "inbound";

export const PLANNING_TABS: Array<{ key: PlanningTab; label: string }> = [
  { key: "demand", label: "Demand" },
  { key: "inbound", label: "Inbound" },
];

/**
 * Planning hub: one nav destination, two existing views.
 *
 * Both views are rendered from the components they were moved into — no logic,
 * formula or endpoint is duplicated here. The hub owns only the heading, the
 * segmented control, and keeping ?tab= in sync so links stay shareable and the
 * /forecast and /planner redirects land on the right tab.
 *
 * Only the active view is mounted, matching the old one-page-at-a-time
 * behaviour: switching tabs remounts and each view re-runs its own loaders
 * exactly as it did when it was its own route.
 */
export function PlanningHub({ initialTab }: { initialTab: PlanningTab }) {
  const [tab, setTab] = useState<PlanningTab>(initialTab);

  function selectTab(next: PlanningTab) {
    setTab(next);
    // Reflect the tab in the URL without a navigation, so a refresh or a
    // copied link reopens the same tab. history API, not router.replace, to
    // avoid re-running the server component for a purely client-side switch.
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

      {tab === "demand" ? <DemandPlannerView /> : <InboundPlannerView />}
    </div>
  );
}
