"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusRule, CourtRuling, AdminRuling, Source } from "@/lib/types";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { Disclaimer } from "@/components/disclaimer";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookOpen, Gavel, FileText, Search, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

function ensureArray<T>(val: T[] | string | null | undefined): T[] {
  if (!val) return [];
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return []; }
  }
  return val;
}

function SourceList({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Primary Sources</p>
      {sources.map((s, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
          <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase">
            {s.type}
          </span>
          <span>{s.citation}{s.description ? ` — ${s.description}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function NexusRuleCard({ rule }: { rule: NexusRule }) {
  const [expanded, setExpanded] = useState(false);
  const sources = ensureArray<Source>(rule.primary_sources);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{rule.state_code}</span>
            <Badge variant="outline" className="text-xs">{rule.rule_type.replaceAll("_", " ")}</Badge>
            <ConfidenceBadge level={rule.confidence} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {rule.position_summary}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          {rule.position_detail && (
            <p className="text-xs leading-relaxed text-muted-foreground">{rule.position_detail}</p>
          )}

          {rule.confidence === "contested" && (
            <div className="rounded-md border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
              <p className="text-xs font-medium text-blue-800 dark:text-blue-300">Contested Position</p>
              {rule.conservative_position && (
                <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
                  <span className="font-medium">Conservative:</span> {rule.conservative_position}
                </p>
              )}
              {rule.aggressive_position && (
                <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
                  <span className="font-medium">Aggressive:</span> {rule.aggressive_position}
                </p>
              )}
              {rule.open_questions && (
                <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
                  <span className="font-medium">Open questions:</span> {rule.open_questions}
                </p>
              )}
            </div>
          )}

          <SourceList sources={sources} />

          {rule.notes && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Notes:</span> {rule.notes}
            </p>
          )}

          <div className="flex gap-4 text-xs text-muted-foreground">
            {rule.effective_date && <span>Effective: {rule.effective_date}</span>}
            {rule.last_reviewed && <span>Reviewed: {rule.last_reviewed}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function CourtRulingCard({ ruling }: { ruling: CourtRuling }) {
  const [expanded, setExpanded] = useState(false);
  const states = ensureArray<string>(ruling.states_affected);
  const tags = ensureArray<string>(ruling.tags);

  const statusColor: Record<string, string> = {
    good_law: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300",
    overruled: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300",
    limited: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300",
    appealed: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300",
  };

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{ruling.case_name}</span>
            <Badge variant="outline" className={`text-xs ${statusColor[ruling.status] ?? ""}`}>
              {ruling.status.replaceAll("_", " ")}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ruling.court} · {ruling.citation}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{ruling.holding_summary}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t pt-3">
          {ruling.holding_detail && (
            <p className="text-xs leading-relaxed text-muted-foreground">{ruling.holding_detail}</p>
          )}
          {ruling.relevance_to_fba && (
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs font-medium">FBA Relevance</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{ruling.relevance_to_fba}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Decided: {ruling.decision_date}</span>
            <span>States: {states.join(", ")}</span>
            {ruling.last_reviewed && <span>Reviewed: {ruling.last_reviewed}</span>}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
              ))}
            </div>
          )}
          {ruling.opinion_url && (
            <a
              href={ruling.opinion_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              <ExternalLink className="h-3 w-3" /> View opinion
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function AdminRulingCard({ ruling }: { ruling: AdminRuling }) {
  const [expanded, setExpanded] = useState(false);
  const states = ensureArray<string>(ruling.states_affected);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{ruling.title}</span>
            <Badge variant="outline" className="text-xs capitalize">{ruling.status}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ruling.issuing_body} · {states.join(", ")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{ruling.summary}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {ruling.relevance_to_fba && (
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs font-medium">FBA Relevance</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{ruling.relevance_to_fba}</p>
            </div>
          )}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Issued: {ruling.issue_date}</span>
            {ruling.last_reviewed && <span>Reviewed: {ruling.last_reviewed}</span>}
          </div>
          {ruling.url && (
            <a
              href={ruling.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              <ExternalLink className="h-3 w-3" /> View source
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default function RulesPage() {
  const [search, setSearch] = useState("");
  const { data: nexusRules, loading: l1 } = useSupabaseQuery<NexusRule>("nexus_rules", {
    filters: { is_active: true },
  });
  const { data: courtRulings, loading: l2 } = useSupabaseQuery<CourtRuling>("court_rulings", {
    filters: { is_active: true },
  });
  const { data: adminRulings, loading: l3 } = useSupabaseQuery<AdminRuling>("admin_rulings", {
    filters: { is_active: true },
  });

  if (l1 || l2 || l3) return <LoadingState />;

  const q = search.toLowerCase();
  const filteredNexus = nexusRules.filter(
    (r) =>
      r.state_code.toLowerCase().includes(q) ||
      r.position_summary.toLowerCase().includes(q) ||
      r.rule_type.toLowerCase().includes(q)
  );
  const filteredCourt = courtRulings.filter(
    (r) =>
      r.case_name.toLowerCase().includes(q) ||
      (r.holding_summary ?? "").toLowerCase().includes(q) ||
      ensureArray<string>(r.states_affected).some((s) => s.toLowerCase().includes(q))
  );
  const filteredAdmin = adminRulings.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      (r.summary ?? "").toLowerCase().includes(q) ||
      ensureArray<string>(r.states_affected).some((s) => s.toLowerCase().includes(q))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Rules & Rulings</h1>
          <p className="text-sm text-muted-foreground">
            Intelligence layer knowledge base with citations
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search rules, rulings, states..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <Tabs defaultValue="nexus">
        <TabsList>
          <TabsTrigger value="nexus" className="gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            Nexus Rules ({filteredNexus.length})
          </TabsTrigger>
          <TabsTrigger value="court" className="gap-1.5">
            <Gavel className="h-3.5 w-3.5" />
            Court ({filteredCourt.length})
          </TabsTrigger>
          <TabsTrigger value="admin" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Admin ({filteredAdmin.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="nexus" className="mt-4">
          {filteredNexus.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="h-8 w-8" />}
              title="No nexus rules"
              description="Seed the intelligence layer to populate rules."
            />
          ) : (
            <div className="space-y-3">
              {filteredNexus.map((r) => (
                <NexusRuleCard key={r.id} rule={r} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="court" className="mt-4">
          {filteredCourt.length === 0 ? (
            <EmptyState
              icon={<Gavel className="h-8 w-8" />}
              title="No court rulings"
              description="Seed the intelligence layer to populate rulings."
            />
          ) : (
            <div className="space-y-3">
              {filteredCourt.map((r) => (
                <CourtRulingCard key={r.id} ruling={r} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="admin" className="mt-4">
          {filteredAdmin.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-8 w-8" />}
              title="No admin rulings"
              description="Seed the intelligence layer to populate rulings."
            />
          ) : (
            <div className="space-y-3">
              {filteredAdmin.map((r) => (
                <AdminRulingCard key={r.id} ruling={r} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Disclaimer />
    </div>
  );
}
