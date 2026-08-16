"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { Search, AlertTriangle, Eye, TrendingUp, Building2 } from "lucide-react";

// ── Types ──────────────────────────────────────────────────

interface EntityFlag {
  type: string;
  severity: string;
  description: string;
}

interface TriageRow {
  state_code: string;
  has_inventory: boolean;
  inventory_first: string | null;
  inventory_last: string | null;
  inventory_events: number;
  posture: string;
  posture_confidence: string;
  posture_citation: string;
  posture_notes: string;
  shopify_sales_12m: number;
  amazon_sales_12m: number;
  economic_nexus_status: string;
  economic_progress_pct: number;
  is_registered: boolean;
  has_entity_tax_flag: boolean;
  entity_flags: EntityFlag[];
  triage_bucket: string;
}

// ── Helpers ────────────────────────────────────────────────

const BUCKET_META: Record<
  string,
  { label: string; color: string; icon: typeof AlertTriangle; description: string }
> = {
  A_discuss: {
    label: "A — Discuss",
    color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    icon: AlertTriangle,
    description: "Inventory nexus asserted/contested + Shopify sales or entity tax flag. Discuss with CPA.",
  },
  D_entity_tax: {
    label: "D — Entity Tax",
    color: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    icon: Building2,
    description: "Franchise, B&O, CAT, or FTB obligation independent of sales tax.",
  },
  C_economic_watch: {
    label: "C — Econ Watch",
    color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    icon: TrendingUp,
    description: "Approaching or exceeding economic nexus threshold.",
  },
  B_monitor: {
    label: "B — Monitor",
    color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    icon: Eye,
    description: "Carve-out, low exposure, or already registered. Monitor only.",
  },
};

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function PostureBadge({ posture, confidence }: { posture: string; confidence: string }) {
  const colors: Record<string, string> = {
    asserts: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    contested: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    carve_out: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${colors[posture] ?? colors.unknown}`}>
      {posture.replace("_", " ")}
      {confidence !== "high" && (
        <span className="text-[9px] opacity-60">({confidence})</span>
      )}
    </span>
  );
}

function EconBadge({ status, pct }: { status: string; pct: number }) {
  if (status === "exceeded")
    return <span className="text-xs font-medium text-red-600 dark:text-red-400">Exceeded</span>;
  if (status === "approaching")
    return <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{pct}%</span>;
  return <span className="text-xs text-muted-foreground">{pct > 0 ? `${pct}%` : "—"}</span>;
}

// ── Main component ─────────────────────────────────────────

export default function TriagePage() {
  const [rows, setRows] = useState<TriageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeBucket, setActiveBucket] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/triage")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  const bucketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.triage_bucket] = (counts[r.triage_bucket] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    let result = rows;
    if (activeBucket) result = result.filter((r) => r.triage_bucket === activeBucket);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.state_code.toLowerCase().includes(q) ||
          r.posture.includes(q) ||
          r.triage_bucket.toLowerCase().includes(q),
      );
    }
    // Sort by bucket priority: A > D > C > B
    const order: Record<string, number> = { A_discuss: 0, D_entity_tax: 1, C_economic_watch: 2, B_monitor: 3 };
    return result.sort((a, b) => (order[a.triage_bucket] ?? 9) - (order[b.triage_bucket] ?? 9));
  }, [rows, search, activeBucket]);

  if (loading) return <LoadingState />;
  if (error) return <p className="p-6 text-red-500">Error: {error}</p>;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Registration Triage
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          CPA research aid — does not recommend registration. Review postures
          and discuss flagged states with your tax advisor.
        </p>
      </div>

      <Disclaimer />

      {/* Bucket cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(["A_discuss", "D_entity_tax", "C_economic_watch", "B_monitor"] as const).map(
          (bucket) => {
            const meta = BUCKET_META[bucket];
            const Icon = meta.icon;
            const count = bucketCounts[bucket] ?? 0;
            const isActive = activeBucket === bucket;
            return (
              <button
                key={bucket}
                onClick={() => setActiveBucket(isActive ? null : bucket)}
                className={`rounded-xl border p-4 text-left transition-all ${
                  isActive
                    ? "ring-2 ring-primary border-primary"
                    : "hover:border-primary/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-2xl font-bold">{count}</span>
                </div>
                <p className="mt-1 text-xs font-medium">{meta.label}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                  {meta.description}
                </p>
              </button>
            );
          },
        )}
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

      {/* Table */}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">State</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead>FBA Posture</TableHead>
                <TableHead className="text-right">Inventory</TableHead>
                <TableHead className="text-right">Shopify 12m</TableHead>
                <TableHead className="text-right">Amazon 12m</TableHead>
                <TableHead>Econ Nexus</TableHead>
                <TableHead>Entity Tax</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No states match the current filter.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((r) => {
                const meta = BUCKET_META[r.triage_bucket] ?? BUCKET_META.B_monitor;
                return (
                  <TableRow key={r.state_code}>
                    <TableCell className="font-medium">
                      {r.state_code}
                      {r.is_registered && (
                        <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">
                          Reg
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger>
                          <PostureBadge posture={r.posture} confidence={r.posture_confidence} />
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-xs">
                          <p className="font-medium">{r.posture_citation || "No citation"}</p>
                          {r.posture_notes && (
                            <p className="mt-1 text-muted-foreground">{r.posture_notes}</p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.has_inventory ? (
                        <Tooltip>
                          <TooltipTrigger>
                            <span className="text-xs">{fmt(r.inventory_events)}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">
                            {r.inventory_first} to {r.inventory_last}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {r.shopify_sales_12m > 0 ? `$${fmt(r.shopify_sales_12m)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {r.amazon_sales_12m > 0 ? `$${fmt(r.amazon_sales_12m)}` : "—"}
                    </TableCell>
                    <TableCell>
                      <EconBadge status={r.economic_nexus_status} pct={r.economic_progress_pct} />
                    </TableCell>
                    <TableCell>
                      {r.has_entity_tax_flag ? (
                        <Tooltip>
                          <TooltipTrigger>
                            <Badge
                              variant="outline"
                              className="border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300 text-[11px]"
                            >
                              {r.entity_flags.length} flag{r.entity_flags.length !== 1 ? "s" : ""}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-sm text-xs">
                            {r.entity_flags.map((f, i) => (
                              <p key={i}>
                                <span className="font-medium">{f.type}</span>: {f.description}
                              </p>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      {r.posture === "contested" && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400">
                          Contested — see citation
                        </span>
                      )}
                      {r.posture === "carve_out" && !r.is_registered && (
                        <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                          MP carve-out may apply
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Posture legend */}
      <Card>
        <CardContent className="py-4">
          <h3 className="text-sm font-medium mb-2">Posture Legend</h3>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground md:grid-cols-4">
            <div>
              <PostureBadge posture="asserts" confidence="medium" />{" "}
              <span className="ml-1">State treats FBA inventory as nexus</span>
            </div>
            <div>
              <PostureBadge posture="carve_out" confidence="medium" />{" "}
              <span className="ml-1">MP facilitator provisions may shield seller</span>
            </div>
            <div>
              <PostureBadge posture="contested" confidence="low" />{" "}
              <span className="ml-1">Active litigation or conflicting guidance</span>
            </div>
            <div>
              <PostureBadge posture="unknown" confidence="low" />{" "}
              <span className="ml-1">Insufficient authority to determine</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
