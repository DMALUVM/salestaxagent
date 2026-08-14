"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule } from "@/lib/types";
import { NexusBadge } from "@/components/status-badge";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function progressColor(pct: number) {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  if (pct >= 50) return "bg-yellow-500";
  return "bg-emerald-500";
}

function NexusTable({
  rows,
  stateRules,
}: {
  rows: NexusStatus[];
  stateRules: Map<string, StateRule>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<MapPin className="h-8 w-8" />}
        title="No nexus data"
        description="Run an analysis to populate nexus status."
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
            <TableHead className="min-w-[200px]">Economic Progress</TableHead>
            <TableHead className="w-24">Registered</TableHead>
            <TableHead className="w-24">Confidence</TableHead>
            <TableHead>Action Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((n) => {
            const rule = stateRules.get(n.state_code);
            const pct = n.economic_progress_percent ?? 0;
            const threshold = rule?.economic_threshold_amount;
            const progressAmt = n.economic_progress_amount ?? 0;

            return (
              <TableRow key={n.state_code}>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger render={<span className="font-semibold" />}>
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
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        ${progressAmt.toLocaleString()}
                        {threshold ? ` / $${threshold.toLocaleString()}` : ""}
                      </span>
                      <span
                        className={`font-medium ${
                          pct >= 100
                            ? "text-red-600 dark:text-red-400"
                            : pct >= 80
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground"
                        }`}
                      >
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-all ${progressColor(pct)}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    {n.has_economic_nexus && (
                      <p className="text-xs font-medium text-red-600 dark:text-red-400">
                        Threshold exceeded
                      </p>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <NexusBadge
                    active={n.is_registered}
                    label={n.is_registered ? "Yes" : "No"}
                  />
                  {n.assigned_frequency && (
                    <p className="mt-0.5 text-xs text-muted-foreground capitalize">
                      {n.assigned_frequency}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <ConfidenceBadge level={n.confidence} />
                </TableCell>
                <TableCell className="max-w-xs">
                  {n.action_notes ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {n.action_notes}
                    </p>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function NexusPage() {
  const [search, setSearch] = useState("");
  const { data: nexus, loading } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: rules } = useSupabaseQuery<StateRule>("state_rules");

  if (loading) return <LoadingState />;

  const stateRules = new Map(rules.map((r) => [r.state_code, r]));
  const filtered = nexus.filter(
    (n) =>
      n.state_code.toLowerCase().includes(search.toLowerCase()) ||
      stateRules
        .get(n.state_code)
        ?.state_name?.toLowerCase()
        .includes(search.toLowerCase())
  );

  const withNexus = filtered.filter(
    (n) => n.has_physical_nexus || n.has_economic_nexus
  );
  const approaching = filtered.filter(
    (n) =>
      !n.has_physical_nexus &&
      !n.has_economic_nexus &&
      (n.economic_progress_percent ?? 0) >= 50
  );
  const safe = filtered.filter(
    (n) =>
      !n.has_physical_nexus &&
      !n.has_economic_nexus &&
      (n.economic_progress_percent ?? 0) < 50
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Nexus Status</h1>
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
              <NexusTable rows={withNexus} stateRules={stateRules} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approaching" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <NexusTable rows={approaching} stateRules={stateRules} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="safe" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <NexusTable rows={safe} stateRules={stateRules} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Disclaimer />
    </div>
  );
}
