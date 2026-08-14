"use client";

import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, FilingEntry, Alert, FranchiseTaxFlag } from "@/lib/types";
import { StatCard } from "@/components/stat-card";
import { Disclaimer } from "@/components/disclaimer";
import { SeverityBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isConfigured } from "@/lib/supabase";
import {
  MapPin,
  TrendingUp,
  Calendar,
  AlertTriangle,
  Bell,
  Shield,
} from "lucide-react";

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code> file to connect the
        dashboard to your compliance data.
      </p>
      <pre className="mt-4 max-w-full overflow-x-auto rounded-lg border bg-muted/50 p-4 text-left text-xs text-muted-foreground">
        {`NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key`}
      </pre>
    </div>
  );
}

export default function OverviewPage() {
  if (!isConfigured()) return <SetupPrompt />;

  const { data: nexus, loading: nexusLoading } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: filings, loading: filingsLoading } = useSupabaseQuery<FilingEntry>("filing_calendar", {
    orderBy: "due_date",
    ascending: true,
  });
  const { data: alerts, loading: alertsLoading } = useSupabaseQuery<Alert>("alerts", {
    orderBy: "sent_at",
    limit: 10,
  });
  const { data: flags } = useSupabaseQuery<FranchiseTaxFlag>("franchise_tax_flags", {
    filters: { status: "open" },
  });

  const loading = nexusLoading || filingsLoading || alertsLoading;
  if (loading) return <LoadingState />;

  const physicalNexusCount = nexus.filter((n) => n.has_physical_nexus).length;
  const approachingEcon = nexus.filter(
    (n) => !n.has_economic_nexus && (n.economic_progress_percent ?? 0) >= 50
  ).length;
  const exceededEcon = nexus.filter((n) => n.has_economic_nexus).length;

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = filings.filter(
    (f) => f.status === "pending" && f.due_date >= today
  );
  const upcomingCount = upcoming.filter((f) => {
    const diff = (new Date(f.due_date).getTime() - Date.now()) / 86400000;
    return diff <= 30;
  }).length;
  const overdueCount = filings.filter(
    (f) => f.status === "pending" && f.due_date < today
  ).length;

  const openFlags = flags.filter((f) => f.severity === "critical").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Multi-state sales tax compliance at a glance
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Physical Nexus"
          value={physicalNexusCount}
          subtitle={`${physicalNexusCount} state${physicalNexusCount !== 1 ? "s" : ""} with FBA inventory`}
          icon={<MapPin className="h-5 w-5" />}
          accent={physicalNexusCount > 0 ? "red" : "green"}
        />
        <StatCard
          title="Economic Nexus"
          value={exceededEcon > 0 ? `${exceededEcon} exceeded` : `${approachingEcon} approaching`}
          subtitle={
            exceededEcon > 0
              ? `${approachingEcon} more approaching`
              : "Monitor sales thresholds"
          }
          icon={<TrendingUp className="h-5 w-5" />}
          accent={exceededEcon > 0 ? "red" : approachingEcon > 0 ? "amber" : "green"}
        />
        <StatCard
          title="Deadlines"
          value={overdueCount > 0 ? `${overdueCount} overdue` : `${upcomingCount} upcoming`}
          subtitle={overdueCount > 0 ? "Action required" : "Next 30 days"}
          icon={<Calendar className="h-5 w-5" />}
          accent={overdueCount > 0 ? "red" : upcomingCount > 0 ? "amber" : "green"}
        />
        <StatCard
          title="Open Flags"
          value={flags.length}
          subtitle={openFlags > 0 ? `${openFlags} critical` : "No critical flags"}
          icon={<AlertTriangle className="h-5 w-5" />}
          accent={openFlags > 0 ? "red" : flags.length > 0 ? "amber" : "green"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Upcoming Filings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">No upcoming filings</p>
            ) : (
              <div className="space-y-2">
                {upcoming.slice(0, 6).map((f) => {
                  const days = Math.ceil(
                    (new Date(f.due_date).getTime() - Date.now()) / 86400000
                  );
                  return (
                    <div
                      key={f.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">{f.state_code}</span>
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
                        {days <= 0 ? "Due today" : `${days}d`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Bell className="h-4 w-4 text-muted-foreground" />
              Recent Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent alerts</p>
            ) : (
              <div className="space-y-2">
                {alerts.slice(0, 6).map((a) => (
                  <div
                    key={a.id}
                    className="flex items-start gap-3 rounded-md border px-3 py-2"
                  >
                    <SeverityBadge severity={a.severity} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{a.title || a.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.state_code && `${a.state_code} · `}
                        {new Date(a.sent_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {flags.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              Open Franchise / Entity Tax Flags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {flags.map((f) => (
                <div key={f.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{f.state_code}</span>
                    <SeverityBadge severity={f.severity} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {f.description}
                  </p>
                  {f.recommended_action && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Recommended:
                      </span>{" "}
                      {f.recommended_action.slice(0, 200)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Disclaimer />
    </div>
  );
}
