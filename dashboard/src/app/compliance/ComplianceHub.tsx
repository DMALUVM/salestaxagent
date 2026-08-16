"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, FranchiseTaxFlag } from "@/lib/types";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { NexusBadge, SeverityBadge } from "@/components/status-badge";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Building2,
  Eye,
  EyeOff,
  CheckCircle,
  Search,
  Shield,
} from "lucide-react";
import { getSupabase } from "@/lib/supabase";

// Extended NexusStatus with compliance fields
interface NexusRow extends NexusStatus {
  compliance_resolved?: boolean;
  compliance_resolved_at?: string | null;
  compliance_hidden?: boolean;
  compliance_notes?: string | null;
}

interface HubState {
  state_code: string;
  state_name: string;
  has_physical: boolean;
  has_economic: boolean;
  is_registered: boolean;
  confidence: string;
  physical_since: string | null;
  economic_pct: number;
  franchise_flags: FranchiseTaxFlag[];
  resolved: boolean;
  hidden: boolean;
  notes: string | null;
  priority: number; // lower = higher priority
}

const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
  CO:"Colorado",CT:"Connecticut",DC:"District of Columbia",DE:"Delaware",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",
  IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",
  ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",
  MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};

function priorityFor(
  has_phys: boolean,
  has_econ: boolean,
  conf: string,
  flagCount: number,
): number {
  let p = 100;
  if (has_phys && (conf === "high" || conf === "critical")) p -= 40;
  else if (has_phys && conf === "medium") p -= 30;
  else if (has_phys && conf === "contested") p -= 20;
  if (has_econ) p -= 25;
  if (flagCount > 0) p -= 15;
  return p;
}

function PostureBadge({ confidence }: { confidence: string }) {
  if (confidence === "contested") {
    return (
      <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800">
        Contested
      </Badge>
    );
  }
  return <ConfidenceBadge level={confidence} />;
}

export default function ComplianceHub() {
  const { data: nexusRows, loading: l1, refetch } = useSupabaseQuery<NexusRow>(
    "nexus_status",
  );
  const { data: flags, loading: l2 } = useSupabaseQuery<FranchiseTaxFlag>(
    "franchise_tax_flags",
    { filters: { status: "open" } },
  );

  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("open");

  const flagsByState = useMemo(() => {
    const m: Record<string, FranchiseTaxFlag[]> = {};
    for (const f of flags) {
      if (!m[f.state_code]) m[f.state_code] = [];
      m[f.state_code].push(f);
    }
    return m;
  }, [flags]);

  const states: HubState[] = useMemo(() => {
    return nexusRows
      .filter((n) => n.has_physical_nexus || n.has_economic_nexus)
      .map((n) => {
        const ff = flagsByState[n.state_code] ?? [];
        return {
          state_code: n.state_code,
          state_name: STATE_NAMES[n.state_code] ?? n.state_code,
          has_physical: n.has_physical_nexus,
          has_economic: n.has_economic_nexus,
          is_registered: n.is_registered,
          confidence: n.confidence ?? "medium",
          physical_since: n.physical_nexus_since,
          economic_pct: n.economic_progress_percent ?? 0,
          franchise_flags: ff,
          resolved: !!(n as NexusRow).compliance_resolved,
          hidden: !!(n as NexusRow).compliance_hidden,
          notes: (n as NexusRow).compliance_notes ?? null,
          priority: priorityFor(
            n.has_physical_nexus,
            n.has_economic_nexus,
            n.confidence ?? "medium",
            ff.length,
          ),
        };
      })
      .sort((a, b) => a.priority - b.priority);
  }, [nexusRows, flagsByState]);

  const openStates = states.filter(
    (s) => !s.is_registered && !s.resolved && !s.hidden,
  );
  const registeredStates = states.filter((s) => s.is_registered && !s.resolved);
  const resolvedStates = states.filter((s) => s.resolved);
  const hiddenStates = states.filter(
    (s) => s.hidden && !s.resolved,
  );

  // Filter by search
  function applySearch(list: HubState[]) {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(
      (s) =>
        s.state_code.toLowerCase().includes(q) ||
        s.state_name.toLowerCase().includes(q),
    );
  }

  async function handleAction(
    stateCode: string,
    action: "resolve" | "unresolve" | "hide" | "unhide",
  ) {
    try {
      const sb = getSupabase();
      const updates: Record<string, unknown> = {};
      if (action === "resolve") {
        updates.compliance_resolved = true;
        updates.compliance_resolved_at = new Date().toISOString();
      } else if (action === "unresolve") {
        updates.compliance_resolved = false;
        updates.compliance_resolved_at = null;
      } else if (action === "hide") {
        updates.compliance_hidden = true;
      } else if (action === "unhide") {
        updates.compliance_hidden = false;
      }
      await sb
        .from("nexus_status")
        .update(updates)
        .eq("state_code", stateCode);
      refetch();
    } catch {
      // Fall back to API route if direct update fails
      await fetch("/api/compliance/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state_code: stateCode, action }),
      });
      refetch();
    }
  }

  if (l1 || l2) return <LoadingState />;

  function StateTable({
    rows,
    showActions = true,
  }: {
    rows: HubState[];
    showActions?: boolean;
  }) {
    const filtered = applySearch(rows);
    if (filtered.length === 0) {
      return (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No states match.
        </p>
      );
    }
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[60px]">State</TableHead>
              <TableHead>Nexus</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Franchise</TableHead>
              <TableHead className="text-right">Econ %</TableHead>
              <TableHead>Guide</TableHead>
              {showActions && <TableHead className="w-[100px]">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((s) => (
              <TableRow key={s.state_code}>
                <TableCell className="font-medium">
                  {s.state_code}
                  {s.is_registered && (
                    <Badge
                      variant="outline"
                      className="ml-1 text-[10px] px-1 py-0 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    >
                      Reg
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    {s.has_physical && (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300"
                      >
                        Physical
                      </Badge>
                    )}
                    {s.has_economic && (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300"
                      >
                        Economic
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <PostureBadge confidence={s.confidence} />
                </TableCell>
                <TableCell>
                  {s.franchise_flags.length > 0 ? (
                    <SeverityBadge
                      severity={s.franchise_flags[0].severity}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {s.economic_pct > 0 ? `${s.economic_pct.toFixed(0)}%` : "—"}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/compliance/${s.state_code}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Open
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </TableCell>
                {showActions && (
                  <TableCell>
                    <div className="flex gap-1">
                      {!s.resolved && !s.hidden && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                            onClick={() =>
                              handleAction(s.state_code, "hide")
                            }
                            title="Hide from default view"
                          >
                            <EyeOff className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                            onClick={() =>
                              handleAction(s.state_code, "resolve")
                            }
                            title="Mark resolved"
                          >
                            <CheckCircle className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                      {s.resolved && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={() =>
                            handleAction(s.state_code, "unresolve")
                          }
                        >
                          Reopen
                        </Button>
                      )}
                      {s.hidden && !s.resolved && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={() =>
                            handleAction(s.state_code, "unhide")
                          }
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          Show
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Compliance Hub
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          States where nexus is detected. Open a guide for registration steps,
          franchise tax notes, and evidence. This is a research aid — not legal advice.
        </p>
      </div>

      <Disclaimer />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <span className="text-2xl font-bold">{openStates.length}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Open — need review
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-blue-500" />
              <span className="text-2xl font-bold">
                {registeredStates.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Registered</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              <span className="text-2xl font-bold">
                {resolvedStates.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Resolved</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <EyeOff className="h-4 w-4 text-muted-foreground" />
              <span className="text-2xl font-bold">
                {hiddenStates.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Hidden</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter states..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="open">
            Open ({openStates.length})
          </TabsTrigger>
          <TabsTrigger value="registered">
            Registered ({registeredStates.length})
          </TabsTrigger>
          <TabsTrigger value="resolved">
            Resolved ({resolvedStates.length})
          </TabsTrigger>
          <TabsTrigger value="hidden">
            Hidden ({hiddenStates.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <StateTable rows={openStates} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="registered" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <StateTable rows={registeredStates} showActions={false} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="resolved" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <StateTable rows={resolvedStates} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="hidden" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <StateTable rows={hiddenStates} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
