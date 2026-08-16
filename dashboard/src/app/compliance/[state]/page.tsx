"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LoadingState } from "@/components/loading";
import { Disclaimer } from "@/components/disclaimer";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { SeverityBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSupabase } from "@/lib/supabase";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  Info,
  Shield,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types (matching ComplianceClient patterns)

interface Step {
  order: number;
  title: string;
  detail?: string;
  url?: string;
  url_label?: string;
  account_to_create?: string;
  form_name?: string;
  frequency?: string;
  deadline_rule?: string;
  documents_needed?: string[];
  common_pitfalls?: string[];
  verification_check?: string;
}

interface Scenario {
  title: string;
  summary?: string;
  severity?: string;
  steps: Step[];
  related_urls?: Record<string, string>;
}

interface PlaybookConfig {
  state_code: string;
  state_name: string;
  last_reviewed?: string;
  confidence?: string;
  sources?: string[];
  scenarios: Record<string, Scenario>;
}

interface Context {
  nexus: Record<string, unknown> | null;
  franchise_flags: Array<Record<string, unknown>>;
  filings: Array<Record<string, unknown>>;
  shopify_total: number;
  amazon_total: number;
  total_sales: number;
}

interface PostureEntry {
  posture: string;
  confidence: string;
  citation: string;
  notes: string;
}

// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StepCard({ step }: { step: Step }) {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {step.order}
        </div>
        <div className="flex-1 space-y-2">
          <h4 className="text-sm font-semibold">{step.title}</h4>
          {step.detail && (
            <p className="text-sm text-muted-foreground">{step.detail}</p>
          )}
          {step.url && (
            <a
              href={step.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline"
            >
              <ExternalLink className="h-3 w-3" />
              {step.url_label ?? "Official link"}
            </a>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {step.account_to_create && (
              <span className="text-muted-foreground">
                <strong>Account:</strong> {step.account_to_create}
              </span>
            )}
            {step.form_name && (
              <span className="text-muted-foreground">
                <strong>Form:</strong> {step.form_name}
              </span>
            )}
            {step.deadline_rule && (
              <span className="text-muted-foreground">
                <strong>Deadline:</strong> {step.deadline_rule}
              </span>
            )}
            {step.frequency && (
              <span className="text-muted-foreground">
                <strong>Frequency:</strong> {step.frequency}
              </span>
            )}
          </div>
          {step.documents_needed && step.documents_needed.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Documents needed:
              </p>
              <ul className="ml-4 list-disc text-xs text-muted-foreground">
                {step.documents_needed.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {step.common_pitfalls && step.common_pitfalls.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Common pitfalls:
              </p>
              <ul className="ml-4 list-disc text-xs text-amber-600 dark:text-amber-400">
                {step.common_pitfalls.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {step.verification_check && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-3 w-3" />
              <span>
                <strong>Done when:</strong> {step.verification_check}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function StateGuidePage() {
  const params = useParams();
  const stateCode = (params.state as string)?.toUpperCase() ?? "";

  const [data, setData] = useState<{
    config: PlaybookConfig;
    playbook_found: boolean;
    context: Context;
  } | null>(null);
  const [posture, setPosture] = useState<PostureEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!stateCode || stateCode.length !== 2) return;
    setLoading(true);
    setError(null);

    // Fetch playbook + context
    fetch(`/api/compliance?state=${stateCode}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    // Fetch posture data (best-effort via triage API)
    fetch("/api/triage")
      .then((r) => r.json())
      .then((d) => {
        const row = (d.rows ?? []).find(
          (r: Record<string, unknown>) => r.state_code === stateCode,
        );
        if (row) {
          setPosture({
            posture: row.posture ?? "unknown",
            confidence: row.posture_confidence ?? "medium",
            citation: row.posture_citation ?? "",
            notes: row.posture_notes ?? "",
          });
        }
      })
      .catch(() => {}); // non-critical
  }, [stateCode]);

  async function handleAction(action: "resolve" | "hide") {
    setActionMsg(null);
    try {
      const sb = getSupabase();
      const updates: Record<string, unknown> = {};
      if (action === "resolve") {
        updates.compliance_resolved = true;
        updates.compliance_resolved_at = new Date().toISOString();
      } else {
        updates.compliance_hidden = true;
      }
      await sb
        .from("nexus_status")
        .update(updates)
        .eq("state_code", stateCode);
      setActionMsg(
        action === "resolve"
          ? "Marked as resolved. Will not appear in Open list."
          : "Hidden from default view. Recoverable under Hidden tab.",
      );
    } catch {
      await fetch("/api/compliance/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state_code: stateCode, action }),
      });
      setActionMsg("Updated.");
    }
  }

  if (loading) return <LoadingState />;
  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  const config = data?.config;
  const ctx = data?.context;
  const nexus = ctx?.nexus as Record<string, unknown> | null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link
          href="/compliance"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          All States
        </Link>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {config?.state_name ?? stateCode} ({stateCode})
          </h1>
          {config?.last_reviewed && (
            <p className="text-xs text-muted-foreground">
              Last reviewed: {config.last_reviewed} &middot; Confidence:{" "}
              <ConfidenceBadge level={config.confidence ?? "medium"} />
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleAction("hide")}
          >
            <EyeOff className="mr-1.5 h-3.5 w-3.5" />
            Hide
          </Button>
          <Button size="sm" onClick={() => handleAction("resolve")}>
            <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
            Mark Resolved
          </Button>
        </div>
      </div>
      {actionMsg && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {actionMsg}
        </p>
      )}

      <Disclaimer />

      {/* Section A: Why this state appears */}
      {ctx && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4 text-muted-foreground" />
              Why {stateCode} Appears
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <p className="text-[10px] text-muted-foreground">
                  Physical Nexus
                </p>
                <p className="font-medium">
                  {nexus?.has_physical_nexus ? "Yes" : "No"}
                  {nexus?.physical_nexus_since ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      since {String(nexus.physical_nexus_since)}
                    </span>
                  ) : null}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">
                  Economic Nexus
                </p>
                <p className="font-medium">
                  {nexus?.has_economic_nexus
                    ? "Exceeded"
                    : `${Number(nexus?.economic_progress_percent ?? 0).toFixed(0)}% of threshold`}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Registered</p>
                <p className="font-medium">
                  {nexus?.is_registered ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">
                  Franchise Flags
                </p>
                <p className="font-medium">
                  {(ctx.franchise_flags?.length ?? 0) > 0
                    ? `${ctx.franchise_flags.length} open`
                    : "None"}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-[10px] text-muted-foreground">
                  Shopify Sales
                </p>
                <p className="tabular-nums">${fmt(ctx.shopify_total)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">
                  Amazon Sales
                </p>
                <p className="tabular-nums">${fmt(ctx.amazon_total)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Total</p>
                <p className="font-medium tabular-nums">
                  ${fmt(ctx.total_sales)}
                </p>
              </div>
            </div>

            {/* FBA posture from triage */}
            {posture && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                <p className="text-xs font-medium">
                  FBA Inventory Posture:{" "}
                  <Badge
                    variant="outline"
                    className={`text-[10px] ml-1 ${
                      posture.posture === "asserts"
                        ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                        : posture.posture === "contested"
                          ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                          : posture.posture === "carve_out"
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                            : ""
                    }`}
                  >
                    {posture.posture.replace("_", " ")}
                  </Badge>
                </p>
                {posture.citation && (
                  <p className="text-[11px] text-muted-foreground">
                    {posture.citation}
                  </p>
                )}
                {posture.notes && (
                  <p className="text-[11px] text-muted-foreground">
                    {posture.notes}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Section E: Marketplace facilitator + franchise flags inline */}
      {ctx && ctx.franchise_flags.length > 0 && (
        <Card className="border-red-200 dark:border-red-900">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Entity / Franchise Tax Flags
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ctx.franchise_flags.map((f, i) => (
              <div
                key={i}
                className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900 dark:bg-red-950/30"
              >
                <div className="flex items-start gap-2">
                  <SeverityBadge
                    severity={f.severity as string}
                  />
                  <div>
                    <p className="text-sm font-medium">
                      {f.description as string}
                    </p>
                    {f.recommended_action ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {String(f.recommended_action)}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Sections B/C/D: Playbook scenarios */}
      {config?.scenarios &&
        Object.entries(config.scenarios).map(([key, scenario]) => (
          <Card key={key}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                {scenario.severity === "critical" ? (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                ) : scenario.severity === "action" ? (
                  <FileText className="h-4 w-4 text-amber-500" />
                ) : (
                  <Info className="h-4 w-4 text-muted-foreground" />
                )}
                {scenario.title}
                {scenario.severity === "critical" && (
                  <Badge className="ml-2 bg-red-500 text-white text-[10px]">
                    Critical
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {scenario.summary && (
                <p className="mb-4 text-sm text-muted-foreground">
                  {scenario.summary}
                </p>
              )}
              <div className="space-y-3">
                {scenario.steps?.map((step) => (
                  <StepCard key={step.order} step={step} />
                ))}
              </div>
              {scenario.related_urls && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(scenario.related_urls).map(
                    ([label, url]) => (
                      <a
                        key={label}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {label.replace(/_/g, " ")}
                      </a>
                    ),
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

      {/* Section F: Evidence links */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Download className="h-4 w-4 text-muted-foreground" />
            Evidence & Exports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/triage"
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Registration Triage
              <ArrowLeft className="h-3 w-3 rotate-180" />
            </Link>
            <a
              href={`/api/exports/inventory-presence?format=pdf`}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
            >
              <Download className="h-3 w-3" />
              Inventory Presence PDF
            </a>
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            These exports are generated from the same data shown above.
            Present to CPA alongside this guide for context.
          </p>
        </CardContent>
      </Card>

      {/* Sources */}
      {config?.sources && config.sources.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          Sources: {config.sources.join(", ")}
        </p>
      )}

      {/* Footer disclaimer */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
        <Shield className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">Not legal or tax advice</p>
          <p>
            This guide is assembled from configured rules and public portal
            patterns. Verify on the official state DOR site before filing or
            paying. Marketplace facilitator collection (Amazon) does not always
            eliminate registration, franchise, or economic-nexus obligations.
          </p>
        </div>
      </div>
    </div>
  );
}
