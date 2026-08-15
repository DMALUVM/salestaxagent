"use client";

import Link from "next/link";
import { useSupabaseQuery } from "@/lib/hooks";
import type {
  NexusStatus,
  FilingEntry,
  FranchiseTaxFlag,
  IngestionLog,
  StateRule,
  SalesByState,
} from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { SeverityBadge } from "@/components/status-badge";
import { USNexusMap } from "@/components/us-map";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { isConfigured } from "@/lib/supabase";
import {
  AlertTriangle,
  Calendar,
  CheckCircle,
  ChevronRight,
  DollarSign,
  MapPin,
  Shield,
  TrendingUp,
} from "lucide-react";

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_URL
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_ANON_KEY
        </code>{" "}
        in your{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          .env.local
        </code>{" "}
        file.
      </p>
    </div>
  );
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function OverviewPage() {
  if (!isConfigured()) return <SetupPrompt />;

  const { data: nexus, loading: l1 } = useSupabaseQuery<NexusStatus>(
    "nexus_status",
  );
  const { data: filings, loading: l2 } = useSupabaseQuery<FilingEntry>(
    "filing_calendar",
    { orderBy: "due_date", ascending: true },
  );
  const { data: flags, loading: l3 } = useSupabaseQuery<FranchiseTaxFlag>(
    "franchise_tax_flags",
    { filters: { status: "open" } },
  );
  const { data: logs } = useSupabaseQuery<IngestionLog>("ingestion_log", {
    orderBy: "ingested_at",
    limit: 5,
  });
  const { data: stateRules } = useSupabaseQuery<StateRule>("state_rules");
  const { data: sales } = useSupabaseQuery<SalesByState>("sales_by_state");

  if (l1 || l2 || l3) return <LoadingState />;

  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();

  // ── Compute overview metrics ──

  const overdue = filings.filter(
    (f) => (f.status === "pending" || f.status === "late") && f.due_date < today,
  );
  const dueSoon = filings.filter((f) => {
    if (f.status !== "pending") return false;
    if (f.due_date < today) return false;
    const days = (new Date(f.due_date).getTime() - nowMs) / 86400000;
    return days <= 30;
  });

  const criticalFlags = flags.filter((f) => f.severity === "critical");

  const registered = nexus.filter((n) => n.is_registered);
  const nexusNotRegistered = nexus.filter(
    (n) =>
      !n.is_registered && (n.has_physical_nexus || n.has_economic_nexus),
  );

  const physCount = nexus.filter((n) => n.has_physical_nexus).length;
  const econExceeded = nexus.filter((n) => n.has_economic_nexus).length;

  const lastSync = logs.find(
    (l) =>
      l.status === "success" &&
      (l.file_type.startsWith("amazon") || l.file_type.startsWith("shopify")),
  );

  const hasUrgent =
    overdue.length > 0 || criticalFlags.length > 0 || nexusNotRegistered.length > 0;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          {hasUrgent
            ? "Items need your attention"
            : "All clear — no urgent actions"}
          {lastSync && (
            <span className="ml-2 text-xs">
              &middot; Last sync {timeAgo(lastSync.ingested_at)}
            </span>
          )}
        </p>
      </div>

      {/* ── Urgent items (red zone) ── */}
      {hasUrgent && (
        <div className="space-y-3">
          {overdue.map((f) => (
            <Link key={f.id} href="/calendar">
              <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 transition-colors hover:bg-red-100 dark:border-red-900 dark:bg-red-950 dark:hover:bg-red-900/50">
                <Calendar className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                <div className="flex-1">
                  <span className="text-sm font-medium text-red-800 dark:text-red-300">
                    OVERDUE — {f.state_code} {f.period_label}
                  </span>
                  <span className="ml-2 text-xs text-red-600 dark:text-red-400">
                    Due {f.due_date}
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 text-red-400" />
              </div>
            </Link>
          ))}

          {criticalFlags.map((f) => (
            <div
              key={f.id}
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                <span className="text-sm font-medium text-red-800 dark:text-red-300">
                  {f.state_code} — {f.flag_type === "franchise_tax" ? "Franchise / Entity Tax" : f.flag_type}
                </span>
                <SeverityBadge severity={f.severity} />
              </div>
              <p className="mt-1 text-xs text-red-700 dark:text-red-400">
                {f.description.slice(0, 200)}
              </p>
              {f.recommended_action && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  <span className="font-medium">Action:</span>{" "}
                  {f.recommended_action.slice(0, 160)}
                </p>
              )}
            </div>
          ))}

          {nexusNotRegistered.length > 0 && (
            <Link href="/registrations">
              <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950 dark:hover:bg-amber-900/50">
                <MapPin className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="flex-1">
                  <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {nexusNotRegistered.length} state
                    {nexusNotRegistered.length !== 1 && "s"} with nexus but not
                    registered
                  </span>
                  <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                    {nexusNotRegistered.map((n) => n.state_code).join(", ")}
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 text-amber-400" />
              </div>
            </Link>
          )}
        </div>
      )}

      {/* ── Summary row ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/liability">
          <Card className="transition-colors hover:border-primary/30">
            <CardContent className="flex items-center gap-3 p-4">
              <DollarSign className="h-5 w-5 text-primary" />
              <div>
                <p className="text-2xl font-semibold">
                  {registered.length}
                </p>
                <p className="text-xs text-muted-foreground">
                  Registered state{registered.length !== 1 && "s"}
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/calendar">
          <Card
            className={`transition-colors hover:border-primary/30 ${
              overdue.length > 0 ? "border-red-200 dark:border-red-900" : ""
            }`}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <Calendar
                className={`h-5 w-5 ${
                  overdue.length > 0
                    ? "text-red-500"
                    : dueSoon.length > 0
                    ? "text-amber-500"
                    : "text-emerald-500"
                }`}
              />
              <div>
                <p className="text-2xl font-semibold">
                  {overdue.length > 0
                    ? overdue.length
                    : dueSoon.length}
                </p>
                <p className="text-xs text-muted-foreground">
                  {overdue.length > 0
                    ? "Overdue filing" + (overdue.length !== 1 ? "s" : "")
                    : "Due next 30d"}
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/nexus">
          <Card className="transition-colors hover:border-primary/30">
            <CardContent className="flex items-center gap-3 p-4">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-semibold">{physCount}</p>
                <p className="text-xs text-muted-foreground">
                  Physical nexus states
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/nexus">
          <Card className="transition-colors hover:border-primary/30">
            <CardContent className="flex items-center gap-3 p-4">
              <TrendingUp
                className={`h-5 w-5 ${
                  econExceeded > 0 ? "text-red-500" : "text-muted-foreground"
                }`}
              />
              <div>
                <p className="text-2xl font-semibold">
                  {econExceeded > 0 ? `${econExceeded}` : "0"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Economic nexus exceeded
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* ── Nexus map ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            Nexus Map
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          <USNexusMap
            nexus={nexus}
            rules={stateRules}
            filings={filings}
            flags={flags}
            sales={sales}
          />
        </CardContent>
      </Card>

      {/* ── Upcoming filings ── */}
      {dueSoon.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Coming Up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {dueSoon.slice(0, 8).map((f) => {
                const days = Math.ceil(
                  (new Date(f.due_date).getTime() - nowMs) / 86400000,
                );
                return (
                  <div
                    key={f.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-8 text-sm font-medium">
                        {f.state_code}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {f.period_label}
                      </span>
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        days <= 7
                          ? "text-red-600 dark:text-red-400"
                          : days <= 14
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {days}d &middot; {f.due_date.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Non-critical franchise flags ── */}
      {flags.filter((f) => f.severity !== "critical").length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              Entity / Franchise Tax Flags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {flags
                .filter((f) => f.severity !== "critical")
                .map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start gap-3 rounded-md border px-3 py-2"
                  >
                    <SeverityBadge severity={f.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {f.state_code}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {f.description.slice(0, 100)}
                        </span>
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── All clear ── */}
      {!hasUrgent && dueSoon.length === 0 && flags.length === 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8 justify-center text-sm text-muted-foreground">
            <CheckCircle className="h-5 w-5 text-emerald-500" />
            No urgent items. Check back after your next filing period.
          </CardContent>
        </Card>
      )}

      {/* ── Disclaimer ── */}
      <p className="text-center text-[11px] text-muted-foreground/60">
        This is a monitoring aid, not legal or tax advice. Consult a qualified
        CPA before acting on any position.
      </p>
    </div>
  );
}
