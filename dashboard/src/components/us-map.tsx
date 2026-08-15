"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useUSGeo, useDarkMode } from "@/lib/use-us-geo";
import type { GeoFeature } from "@/lib/use-us-geo";
import type {
  NexusStatus,
  StateRule,
  FilingEntry,
  FranchiseTaxFlag,
  SalesByState,
} from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON, STATE_TAX_RATES } from "@/lib/channels";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  DollarSign,
  MapPin,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Status tier assignment (highest priority wins)
// ---------------------------------------------------------------------------

export type StatusTier = "critical" | "watch" | "registered" | "neutral";

const TIER_COLORS: Record<
  StatusTier,
  { light: string; dark: string; label: string }
> = {
  critical: { light: "#ef4444", dark: "#dc2626", label: "Action needed" },
  watch: { light: "#f59e0b", dark: "#d97706", label: "Watch" },
  registered: { light: "#22c55e", dark: "#16a34a", label: "Registered" },
  neutral: { light: "#e5e7eb", dark: "#374151", label: "No signal" },
};

interface StateStatus {
  tier: StatusTier;
  nexus: NexusStatus | null;
  rule: StateRule | null;
  flags: FranchiseTaxFlag[];
  overdue: FilingEntry[];
  nextDue: FilingEntry | null;
  shopifySinceFiling: number;
  amazonSinceFiling: number;
  estTax: number;
}

export function computeStateStatuses(
  nexus: NexusStatus[],
  rules: StateRule[],
  filings: FilingEntry[],
  flags: FranchiseTaxFlag[],
  sales: SalesByState[],
): Record<string, StateStatus> {
  const today = new Date().toISOString().slice(0, 10);
  const nexusMap = new Map(nexus.map((n) => [n.state_code, n]));
  const ruleMap = new Map(rules.map((r) => [r.state_code, r]));

  const flagMap: Record<string, FranchiseTaxFlag[]> = {};
  for (const f of flags) (flagMap[f.state_code] ??= []).push(f);

  const overdueMap: Record<string, FilingEntry[]> = {};
  const nextDueMap: Record<string, FilingEntry> = {};
  for (const f of filings) {
    const sc = f.state_code;
    if (
      (f.status === "pending" || f.status === "late") &&
      f.due_date < today
    ) {
      (overdueMap[sc] ??= []).push(f);
    } else if (f.status === "pending" && f.due_date >= today) {
      if (!nextDueMap[sc] || f.due_date < nextDueMap[sc].due_date)
        nextDueMap[sc] = f;
    }
  }

  const salesByState: Record<string, { shopify: number; amazon: number }> =
    {};
  for (const s of sales) {
    const sc = s.state_code;
    if (!salesByState[sc]) salesByState[sc] = { shopify: 0, amazon: 0 };
    const n = nexusMap.get(sc);
    const filedThrough = n?.last_filed_through ?? null;
    if (filedThrough && s.period_end <= filedThrough) continue;
    const ch = normalizeChannel(s.channel);
    if (ch === SHOPIFY) salesByState[sc].shopify += s.gross_sales;
    else if (ch === AMAZON) salesByState[sc].amazon += s.gross_sales;
  }

  const result: Record<string, StateStatus> = {};
  const allCodes = new Set([
    ...nexus.map((n) => n.state_code),
    ...rules.filter((r) => r.has_sales_tax).map((r) => r.state_code),
  ]);

  for (const sc of allCodes) {
    const n = nexusMap.get(sc) ?? null;
    const r = ruleMap.get(sc) ?? null;
    const stateFlags = flagMap[sc] ?? [];
    const overdue = overdueMap[sc] ?? [];
    const nextDue = nextDueMap[sc] ?? null;
    const sa = salesByState[sc] ?? { shopify: 0, amazon: 0 };
    const rate = STATE_TAX_RATES[sc] ?? 0;

    let tier: StatusTier = "neutral";
    const hasCriticalFlag = stateFlags.some(
      (f) => f.severity === "critical",
    );
    const isOverdue = overdue.length > 0;
    const hasNexus = n?.has_physical_nexus || n?.has_economic_nexus;
    const isRegistered = n?.is_registered ?? false;
    const econExceeded = n?.has_economic_nexus ?? false;
    const econApproaching = (n?.economic_progress_percent ?? 0) >= 50;

    if (isOverdue || hasCriticalFlag || (econExceeded && !isRegistered))
      tier = "critical";
    else if (!isRegistered && ((hasNexus) || econApproaching))
      tier = "watch";
    else if (isRegistered) tier = "registered";

    result[sc] = {
      tier,
      nexus: n,
      rule: r,
      flags: stateFlags,
      overdue,
      nextDue,
      shopifySinceFiling: sa.shopify,
      amazonSinceFiling: sa.amazon,
      estTax: sa.shopify * rate,
    };
  }

  return result;
}

// FIPS mapping + GeoFeature type imported from @/lib/use-us-geo

// ---------------------------------------------------------------------------
// State detail drawer
// ---------------------------------------------------------------------------

function StateDrawer({
  code,
  status,
  open,
  onClose,
}: {
  code: string;
  status: StateStatus;
  open: boolean;
  onClose: () => void;
}) {
  const { nexus: n, rule: r, flags, overdue, nextDue } = status;
  const name = r?.state_name ?? code;
  const dueDays = nextDue
    ? Math.ceil(
        (new Date(nextDue.due_date).getTime() - Date.now()) / 86400000,
      )
    : null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-80 sm:w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="text-lg">{code}</span>
            <span className="text-base font-normal text-muted-foreground">
              {name}
            </span>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <Badge
            variant="outline"
            className={
              status.tier === "critical"
                ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                : status.tier === "watch"
                ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : status.tier === "registered"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : ""
            }
          >
            {TIER_COLORS[status.tier].label}
          </Badge>

          {overdue.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
              <span className="font-medium text-red-700 dark:text-red-300">
                {overdue.length} overdue filing
                {overdue.length !== 1 && "s"}
              </span>
            </div>
          )}

          {flags.map((f) => (
            <div
              key={f.id}
              className={`rounded-lg border p-3 text-sm ${
                f.severity === "critical"
                  ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950"
                  : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950"
              }`}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">
                  {f.flag_type.replace(/_/g, " ")}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {f.description.slice(0, 150)}
              </p>
            </div>
          ))}

          {/* Nexus */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Nexus
            </h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                Physical
              </div>
              <span className="text-right">
                {n?.has_physical_nexus ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                  >
                    Yes
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">No</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                Economic
              </div>
              <span className="text-right">
                {n?.has_economic_nexus ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                  >
                    Exceeded
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">
                    {(n?.economic_progress_percent ?? 0) > 0
                      ? `${Math.round(n?.economic_progress_percent ?? 0)}%`
                      : "—"}
                  </span>
                )}
              </span>
            </div>
            {n?.physical_nexus_source && (
              <p className="text-xs text-muted-foreground">
                {n.physical_nexus_source.slice(0, 100)}
              </p>
            )}
          </div>

          {/* Filing */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Filing
            </h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span>Registered</span>
              <span className="text-right">
                {n?.is_registered ? (
                  <span className="flex items-center justify-end gap-1 text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" /> Yes
                  </span>
                ) : (
                  <span className="text-muted-foreground">No</span>
                )}
              </span>
              {n?.is_registered && (
                <>
                  <span>Frequency</span>
                  <span className="text-right capitalize text-muted-foreground">
                    {(
                      n.assigned_frequency ??
                      r?.filing_frequency_default ??
                      "—"
                    ).replace("_", "-")}
                  </span>
                  <span>Filed through</span>
                  <span className="text-right text-muted-foreground">
                    {n.last_filed_through ?? "Not set"}
                  </span>
                </>
              )}
              {nextDue && (
                <>
                  <span>Next due</span>
                  <span
                    className={`text-right font-medium ${
                      (dueDays ?? 99) <= 7
                        ? "text-red-600 dark:text-red-400"
                        : (dueDays ?? 99) <= 14
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {nextDue.due_date}
                    {dueDays !== null && (
                      <span className="ml-1 text-xs">({dueDays}d)</span>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Sales since filing */}
          {n?.is_registered && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Since Last Filing
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span>Shopify sales</span>
                <span className="text-right font-medium tabular-nums">
                  $
                  {status.shopifySinceFiling.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span>Est. tax owed</span>
                <span className="text-right font-medium tabular-nums text-amber-600 dark:text-amber-400">
                  $
                  {status.estTax.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span className="text-muted-foreground">Amazon (ref)</span>
                <span className="text-right tabular-nums text-muted-foreground">
                  $
                  {status.amazonSinceFiling.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Estimate only. Base state rate, no local surcharges.
              </p>
            </div>
          )}

          {/* Quick links */}
          <div className="space-y-1 pt-2">
            {[
              {
                href: "/liability",
                icon: DollarSign,
                label: "What Do I Owe?",
              },
              {
                href: "/registrations",
                icon: ShieldCheck,
                label: "Registrations",
              },
              {
                href: "/calendar",
                icon: Calendar,
                label: "Filing Calendar",
              },
            ].map(({ href, icon: Icon, label }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
                onClick={onClose}
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {label}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Map component — real Census TIGER boundaries via topojson
// ---------------------------------------------------------------------------

interface USNexusMapProps {
  nexus: NexusStatus[];
  rules: StateRule[];
  filings: FilingEntry[];
  flags: FranchiseTaxFlag[];
  sales: SalesByState[];
}

export function USNexusMap({
  nexus,
  rules,
  filings,
  flags,
  sales,
}: USNexusMapProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const features = useUSGeo();
  const isDark = useDarkMode();

  const statuses = useMemo(
    () => computeStateStatuses(nexus, rules, filings, flags, sales),
    [nexus, rules, filings, flags, sales],
  );

  const selectedStatus = selected ? statuses[selected] : null;

  function fillFor(sc: string): string {
    const s = statuses[sc];
    if (!s)
      return isDark ? TIER_COLORS.neutral.dark : TIER_COLORS.neutral.light;
    const c = TIER_COLORS[s.tier];
    return isDark ? c.dark : c.light;
  }

  const tierCounts = useMemo(() => {
    const counts: Record<StatusTier, number> = {
      critical: 0,
      watch: 0,
      registered: 0,
      neutral: 0,
    };
    for (const s of Object.values(statuses)) counts[s.tier]++;
    return counts;
  }, [statuses]);

  if (features.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        Loading map…
      </div>
    );
  }

  return (
    <div>
      <div className="relative w-full overflow-hidden rounded-lg border bg-card">
        <svg
          viewBox="0 0 975 610"
          className="w-full h-auto"
          role="img"
          aria-label="US nexus status map"
        >
          {features.map(({ stateCode, name, path }) => (
            <path
              key={stateCode}
              d={path}
              fill={fillFor(stateCode)}
              stroke={isDark ? "#1f2937" : "#ffffff"}
              strokeWidth={0.75}
              className="cursor-pointer transition-opacity duration-150 hover:opacity-75"
              onClick={() => setSelected(stateCode)}
            >
              <title>
                {stateCode} — {name}
              </title>
            </path>
          ))}
        </svg>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {(
          ["critical", "watch", "registered", "neutral"] as StatusTier[]
        ).map((tier) => (
          <div key={tier} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{
                backgroundColor: isDark
                  ? TIER_COLORS[tier].dark
                  : TIER_COLORS[tier].light,
              }}
            />
            <span className="text-[11px] text-muted-foreground">
              {TIER_COLORS[tier].label}
              {tierCounts[tier] > 0 && (
                <span className="ml-0.5 font-medium">
                  ({tierCounts[tier]})
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {selected && selectedStatus && (
        <StateDrawer
          code={selected}
          status={selectedStatus}
          open={!!selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
