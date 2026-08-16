"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSupabaseQuery } from "@/lib/hooks";
import { isRegistered } from "@/lib/compliance-status";
import type {
  NexusStatus,
  FilingEntry,
  FranchiseTaxFlag,
  SalesByState,
  IngestionLog,
} from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { LoadingState } from "@/components/loading";
import { SeverityBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { isConfigured } from "@/lib/supabase";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  DollarSign,
  MapPin,
  Package,
  Shield,
  ShoppingBag,
  TrendingUp,
  FileDown,
  Map,
  ClipboardCheck,
} from "lucide-react";

// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type ChFilter = "all" | "shopify" | "amazon";

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code>.
      </p>
    </div>
  );
}

function timeAgo(s: string) {
  const d = Date.now() - new Date(s).getTime();
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---------------------------------------------------------------------------

export default function PulsePage() {
  if (!isConfigured()) return <SetupPrompt />;

  const [ch, setCh] = useState<ChFilter>("all");

  const { data: sales, loading: l1 } = useSupabaseQuery<SalesByState>("sales_by_state");
  const { data: nexus, loading: l2 } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: filings, loading: l3 } = useSupabaseQuery<FilingEntry>("filing_calendar", {
    orderBy: "due_date", ascending: true,
  });
  const { data: flags } = useSupabaseQuery<FranchiseTaxFlag>("franchise_tax_flags", {
    filters: { status: "open" },
  });
  const { data: logs } = useSupabaseQuery<IngestionLog>("ingestion_log", {
    orderBy: "ingested_at", limit: 5,
  });

  // ── Compute period boundaries ──
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonth = now.getMonth() === 0
    ? `${now.getFullYear() - 1}-12`
    : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;

  const mtd = useMemo(() => {
    let gross = 0, orders = 0;
    for (const s of sales) {
      if (!s.period_start?.startsWith(thisMonth)) continue;
      const c = normalizeChannel(s.channel);
      if (ch !== "all" && c !== ch) continue;
      gross += s.gross_sales;
      orders += s.order_count;
    }
    return { gross, orders };
  }, [sales, thisMonth, ch]);

  const lastMo = useMemo(() => {
    let gross = 0, orders = 0;
    for (const s of sales) {
      if (!s.period_start?.startsWith(lastMonth)) continue;
      const c = normalizeChannel(s.channel);
      if (ch !== "all" && c !== ch) continue;
      gross += s.gross_sales;
      orders += s.order_count;
    }
    return { gross, orders };
  }, [sales, lastMonth, ch]);

  if (l1 || l2 || l3) return <LoadingState />;

  const today = now.toISOString().slice(0, 10);

  // ── Tax actions ──
  const overdue = filings.filter(
    (f) => (f.status === "pending" || f.status === "late") && f.due_date < today,
  );
  const upcoming = filings
    .filter((f) => f.status === "pending" && f.due_date >= today)
    .slice(0, 3);
  const criticalFlags = (flags ?? []).filter((f) => f.severity === "critical");
  const unregNexus = nexus.filter(
    (n) => !isRegistered(n.is_registered) && (n.has_physical_nexus || n.has_economic_nexus),
  );
  const econExceeded = nexus.filter((n) => n.has_economic_nexus && !isRegistered(n.is_registered));

  // Top 3 critical items
  const criticalItems: { label: string; href: string }[] = [];
  for (const f of criticalFlags.slice(0, 2))
    criticalItems.push({ label: `${f.state_code} — ${f.flag_type.replace(/_/g, " ")}`, href: "/nexus" });
  for (const sc of econExceeded.slice(0, 2))
    criticalItems.push({ label: `${sc.state_code} — economic threshold exceeded`, href: "/nexus" });
  if (overdue.length > 0)
    criticalItems.push({ label: `${overdue.length} overdue filing${overdue.length > 1 ? "s" : ""}`, href: "/calendar" });

  const actionCount = overdue.length + criticalFlags.length + unregNexus.length;
  const lastSync = logs?.find((l) => l.status === "success");

  const chLabel = ch === "all" ? "All Channels" : ch === "amazon" ? "Amazon" : "Shopify";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pulse</h1>
          <p className="text-sm text-muted-foreground">
            Daily command center
            {lastSync && (
              <span className="ml-1">
                &middot; Synced {timeAgo(lastSync.ingested_at)} ago
              </span>
            )}
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-muted p-0.5">
          {(["all", "amazon", "shopify"] as ChFilter[]).map((v) => (
            <button
              key={v}
              onClick={() => setCh(v)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                ch === v
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {v === "all" ? "All" : v === "amazon" ? "Amazon" : "Shopify"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sales cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              MTD Gross ({chLabel})
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(mtd.gross))}
            </p>
            <p className="text-xs text-muted-foreground">{fmt(mtd.orders)} orders</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Last Month ({chLabel})
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(lastMo.gross))}
            </p>
            <p className="text-xs text-muted-foreground">{fmt(lastMo.orders)} orders</p>
          </CardContent>
        </Card>
        <Card className={actionCount > 0 ? "border-amber-500/30" : ""}>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Open Tax Actions
            </p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${actionCount > 0 ? "text-amber-500" : ""}`}>
              {actionCount}
            </p>
            <p className="text-xs text-muted-foreground">
              {overdue.length > 0 ? `${overdue.length} overdue` : "No overdue"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Registered States
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {nexus.filter((n) => isRegistered(n.is_registered)).length}
            </p>
            <p className="text-xs text-muted-foreground">
              {nexus.filter((n) => n.has_physical_nexus).length} physical nexus
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Critical items + Deadlines ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Critical items */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Top Actions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {criticalItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No critical items. You&apos;re in good shape.
              </p>
            ) : (
              <div className="space-y-2">
                {criticalItems.slice(0, 4).map((item, i) => (
                  <Link key={i} href={item.href}>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted">
                      <span>{item.label}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Next deadlines */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Next Deadlines
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 && overdue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming deadlines.</p>
            ) : (
              <div className="space-y-2">
                {overdue.slice(0, 2).map((f) => (
                  <Link key={f.id} href="/calendar">
                    <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950">
                      <span className="font-medium text-red-700 dark:text-red-300">
                        OVERDUE — {f.state_code} {f.period_label}
                      </span>
                      <span className="text-xs text-red-600 dark:text-red-400">
                        {f.due_date}
                      </span>
                    </div>
                  </Link>
                ))}
                {upcoming.map((f) => {
                  const days = Math.ceil(
                    (new Date(f.due_date).getTime() - Date.now()) / 86400000,
                  );
                  return (
                    <div
                      key={f.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                    >
                      <span>
                        {f.state_code}{" "}
                        <span className="text-muted-foreground">{f.period_label}</span>
                      </span>
                      <span
                        className={`text-xs font-medium ${
                          days <= 7 ? "text-red-500" : days <= 14 ? "text-amber-500" : "text-muted-foreground"
                        }`}
                      >
                        {days}d &middot; {f.due_date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Quick links ── */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { href: "/sales-map", icon: Map, label: "Sales Map" },
          { href: "/liability", icon: DollarSign, label: "What Do I Owe?" },
          { href: "/registrations", icon: ClipboardCheck, label: "Registrations" },
          { href: "/skus", icon: Package, label: "SKU Performance" },
          { href: "/nexus", icon: MapPin, label: "Nexus Monitor" },
          { href: "/data", icon: FileDown, label: "Data & Export" },
        ].map(({ href, icon: Icon, label }) => (
          <Link key={href} href={href}>
            <Card className="transition-colors hover:border-primary/30">
              <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <span className="text-xs font-medium">{label}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* ── Sync health ── */}
      {logs && logs.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 p-3 text-xs text-muted-foreground">
            {(() => {
              const shopifySync = logs.find(
                (l) => l.status === "success" && l.file_type?.startsWith("shopify"),
              );
              const amazonSync = logs.find(
                (l) => l.status === "success" && l.file_type?.startsWith("amazon"),
              );
              const stale = (l: typeof shopifySync) =>
                l ? (Date.now() - new Date(l.ingested_at).getTime()) / 3600000 > 36 : true;

              return (
                <>
                  <span>
                    Shopify:{" "}
                    <span className={stale(shopifySync) ? "text-amber-500 font-medium" : ""}>
                      {shopifySync ? timeAgo(shopifySync.ingested_at) + " ago" : "never"}
                    </span>
                  </span>
                  <span>
                    Amazon:{" "}
                    <span className={stale(amazonSync) ? "text-amber-500 font-medium" : ""}>
                      {amazonSync ? timeAgo(amazonSync.ingested_at) + " ago" : "never"}
                    </span>
                  </span>
                  {(stale(shopifySync) || stale(amazonSync)) && (
                    <span className="text-amber-500">
                      Data may be stale (&gt;36h)
                    </span>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
      )}

      <p className="text-center text-[11px] text-muted-foreground/60">
        Monitoring aid — not legal or tax advice.
      </p>
    </div>
  );
}
