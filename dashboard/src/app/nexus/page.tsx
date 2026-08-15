"use client";

import { useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule, SalesByState } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { NexusBadge } from "@/components/status-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MapPin, Search } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function barColor(pct: number) {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  if (pct >= 50) return "bg-yellow-500";
  return "bg-emerald-500";
}

function pctColor(pct: number) {
  if (pct >= 100) return "text-red-600 dark:text-red-400";
  if (pct >= 80) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${barColor(pct)}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Total volume computation (Shopify + Amazon per state, all data in DB)
// ---------------------------------------------------------------------------

interface StateVolume {
  shopify: number;
  amazon: number;
  total: number;
}

function computeVolumes(
  sales: SalesByState[],
): Record<string, StateVolume> {
  const m: Record<string, StateVolume> = {};
  for (const s of sales) {
    const sc = s.state_code;
    if (!m[sc]) m[sc] = { shopify: 0, amazon: 0, total: 0 };
    const ch = normalizeChannel(s.channel);
    const amt = s.gross_sales;
    m[sc].total += amt;
    if (ch === SHOPIFY) m[sc].shopify += amt;
    else if (ch === AMAZON) m[sc].amazon += amt;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Economic progress cell
// ---------------------------------------------------------------------------

function EconomicCell({
  n,
  rule,
  volume,
}: {
  n: NexusStatus;
  rule: StateRule | undefined;
  volume: StateVolume | undefined;
}) {
  const amt = n.economic_progress_amount ?? 0;
  const txns = n.economic_progress_transactions ?? 0;
  const threshAmt = rule?.economic_threshold_amount ?? null;
  const threshTxn = rule?.economic_threshold_transactions ?? null;
  const testType = rule?.threshold_test_type ?? "or";
  const isAnd = testType === "and";

  if (!threshAmt) {
    return <span className="text-xs text-muted-foreground">&mdash;</span>;
  }

  const amtPct = (amt / threshAmt) * 100;
  const txnPct = threshTxn ? (txns / threshTxn) * 100 : 0;
  const amtExceeded = amtPct >= 100;
  const txnExceeded = threshTxn ? txnPct >= 100 : false;

  // AND: both must be met; OR: either triggers
  const currentlyExceeded = isAnd
    ? amtExceeded && (threshTxn ? txnExceeded : true)
    : amtExceeded || txnExceeded;

  let statusLabel = "";
  if (n.has_economic_nexus) {
    if (currentlyExceeded) {
      if (isAnd)
        statusLabel = "Exceeded (both sales AND transactions met)";
      else if (amtExceeded && txnExceeded)
        statusLabel = "Exceeded (sales + transactions)";
      else if (txnExceeded)
        statusLabel = `Exceeded on transactions (${fmt(txns)} / ${threshTxn})`;
      else
        statusLabel = `Exceeded on sales ($${fmt(amt)} / $${fmt(threshAmt)})`;
    } else {
      statusLabel =
        "Threshold was exceeded in a prior period; obligation may continue \u2014 confirm with CPA";
    }
  }

  const totalVol = volume?.total ?? 0;

  return (
    <div className="space-y-2">
      {/* Dollar threshold progress */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            ${fmt(amt)} / ${fmt(threshAmt)}
          </span>
          <span className={`font-medium tabular-nums ${pctColor(amtPct)}`}>
            {amtPct.toFixed(0)}%
          </span>
        </div>
        <ProgressBar pct={amtPct} />
      </div>

      {/* AND/OR label between the two metrics */}
      {threshTxn != null && (
        <p className="text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          {isAnd ? "and" : "or"}
        </p>
      )}

      {/* Transaction threshold progress */}
      {threshTxn != null && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {fmt(txns)} / {fmt(threshTxn)} transactions
            </span>
            <span
              className={`font-medium tabular-nums ${pctColor(txnPct)}`}
            >
              {txnPct.toFixed(0)}%
            </span>
          </div>
          <ProgressBar pct={txnPct} />
        </div>
      )}

      {/* Exceeded label */}
      {statusLabel && (
        <p className="text-xs font-medium text-red-600 dark:text-red-400">
          {statusLabel}
        </p>
      )}

      {/* Channel breakdown + marketplace flag */}
      {volume && (volume.shopify > 0 || volume.amazon > 0) && (
        <p className="text-[10px] text-muted-foreground">
          Shopify ${fmt(Math.round(volume.shopify))} + Amazon $
          {fmt(Math.round(volume.amazon))}
          {rule?.marketplace_sales_count_toward_threshold === false && (
            <span className="ml-1 font-medium">
              (Amazon excluded from threshold)
            </span>
          )}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function NexusTable({
  rows,
  stateRules,
  volumes,
}: {
  rows: NexusStatus[];
  stateRules: Map<string, StateRule>;
  volumes: Record<string, StateVolume>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<MapPin className="h-8 w-8" />}
        title="No states in this category"
        description="Run an analysis or ingest data to populate nexus status."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">State</TableHead>
            <TableHead className="w-28">Physical</TableHead>
            <TableHead className="min-w-[240px]">
              Economic Threshold Progress
            </TableHead>
            <TableHead className="w-24">Registered</TableHead>
            <TableHead className="w-20">Confidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((n) => {
            const rule = stateRules.get(n.state_code);
            return (
              <TableRow key={n.state_code}>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="font-semibold" />}
                    >
                      {n.state_code}
                    </TooltipTrigger>
                    <TooltipContent>
                      {rule?.state_name ?? n.state_code}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <NexusBadge active={n.has_physical_nexus} />
                  {n.physical_nexus_since && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Since {n.physical_nexus_since.slice(0, 10)}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <EconomicCell
                    n={n}
                    rule={rule}
                    volume={volumes[n.state_code]}
                  />
                </TableCell>
                <TableCell>
                  {n.is_registered ? (
                    <Badge
                      variant="outline"
                      className="text-xs border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    >
                      Yes
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No
                    </span>
                  )}
                  {n.is_registered && n.assigned_frequency && (
                    <p className="mt-0.5 text-xs text-muted-foreground capitalize">
                      {n.assigned_frequency.replace("_", "-")}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <ConfidenceBadge level={n.confidence} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NexusPage() {
  const [search, setSearch] = useState("");
  const { data: nexus, loading: l1 } =
    useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: rules, loading: l2 } =
    useSupabaseQuery<StateRule>("state_rules");
  const { data: sales, loading: l3 } =
    useSupabaseQuery<SalesByState>("sales_by_state");

  const volumes = useMemo(() => computeVolumes(sales), [sales]);

  if (l1 || l2 || l3) return <LoadingState />;

  const stateRules = new Map(rules.map((r) => [r.state_code, r]));

  const filtered = nexus.filter(
    (n) =>
      n.state_code.toLowerCase().includes(search.toLowerCase()) ||
      stateRules
        .get(n.state_code)
        ?.state_name?.toLowerCase()
        .includes(search.toLowerCase()),
  );

  // Active: has physical or economic nexus
  const withNexus = filtered.filter(
    (n) => n.has_physical_nexus || n.has_economic_nexus,
  );

  // Approaching: no nexus yet, but economic progress >= 50% on either metric,
  // AND not already registered (registered states don't need a "watch" alert)
  const approaching = filtered.filter((n) => {
    if (n.has_physical_nexus || n.has_economic_nexus) return false;
    if (n.is_registered) return false;
    return (n.economic_progress_percent ?? 0) >= 50;
  });

  // Below threshold: everything else
  const safe = filtered.filter(
    (n) =>
      !n.has_physical_nexus &&
      !n.has_economic_nexus &&
      ((n.economic_progress_percent ?? 0) < 50 || n.is_registered),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Nexus Monitor
          </h1>
          <p className="text-sm text-muted-foreground">
            Physical and economic nexus by state
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter states..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <Tabs defaultValue="nexus">
        <TabsList>
          <TabsTrigger value="nexus">
            Active Nexus ({withNexus.length})
          </TabsTrigger>
          <TabsTrigger value="approaching">
            Approaching ({approaching.length})
          </TabsTrigger>
          <TabsTrigger value="safe">
            Below Threshold ({safe.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="nexus" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <NexusTable
                rows={withNexus}
                stateRules={stateRules}
                volumes={volumes}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approaching" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <NexusTable
                rows={approaching}
                stateRules={stateRules}
                volumes={volumes}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="safe" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <NexusTable
                rows={safe}
                stateRules={stateRules}
                volumes={volumes}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Disclaimer />
    </div>
  );
}
