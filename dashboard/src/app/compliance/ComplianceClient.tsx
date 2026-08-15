"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertTriangle,
  CheckCircle,
  Download,
  ExternalLink,
  FileText,
  Info,
  Search,
  Shield,
} from "lucide-react";

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export default function CompliancePage() {
  const searchParams = useSearchParams();
  const stateParam = searchParams.get("state")?.toUpperCase() ?? "";

  const [state, setState] = useState(stateParam || "CA");
  const [inputVal, setInputVal] = useState(stateParam || "CA");
  const [data, setData] = useState<{
    config: PlaybookConfig;
    context: Context;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state) return;
    setLoading(true);
    setError(null);
    fetch(`/api/compliance?state=${state}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [state]);

  function handleSearch() {
    const v = inputVal.trim().toUpperCase();
    if (v.length === 2) setState(v);
  }

  if (loading && !data) return <LoadingState />;

  const config = data?.config;
  const ctx = data?.context;
  const nexus = ctx?.nexus as Record<string, unknown> | null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Compliance Guide
            {config?.state_name && (
              <span className="ml-2 text-muted-foreground">
                — {config.state_name} ({config.state_code})
              </span>
            )}
          </h1>
          {config?.last_reviewed && (
            <p className="text-xs text-muted-foreground">
              Last reviewed: {config.last_reviewed} &middot;
              Confidence:{" "}
              <Badge variant="outline" className="ml-1 text-[10px]">
                {config.confidence ?? "medium"}
              </Badge>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="State code (e.g. CA)"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="w-28 text-center uppercase"
          />
          <Button size="sm" onClick={handleSearch}>
            <Search className="mr-1 h-3.5 w-3.5" />
            Load
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
        <Shield className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">Not legal or tax advice</p>
          <p>
            This guide is assembled from configured rules and public portal
            patterns. Verify on the official state site before filing or paying.
            Marketplace facilitator collection (Amazon) does not always
            eliminate registration, franchise, or economic-nexus obligations.
          </p>
        </div>
      </div>

      {ctx && (
        <>
          {/* Context card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Your Status in {config?.state_code}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-[10px] text-muted-foreground">Physical Nexus</p>
                  <p className="font-medium">
                    {nexus?.has_physical_nexus ? "Yes" : "No"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Economic Nexus</p>
                  <p className="font-medium">
                    {nexus?.has_economic_nexus ? "Yes" : "No"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Registered</p>
                  <p className="font-medium">
                    {nexus?.is_registered ? "Yes" : "No"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Franchise Flags</p>
                  <p className="font-medium">
                    {(ctx.franchise_flags?.length ?? 0) > 0
                      ? `${ctx.franchise_flags.length} open`
                      : "None"}
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-[10px] text-muted-foreground">Shopify Sales</p>
                  <p className="tabular-nums">${fmt(ctx.shopify_total)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Amazon Sales</p>
                  <p className="tabular-nums">${fmt(ctx.amazon_total)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Total</p>
                  <p className="font-medium tabular-nums">${fmt(ctx.total_sales)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Scenarios */}
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

          {/* Sources */}
          {config?.sources && config.sources.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Sources: {config.sources.join(", ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
