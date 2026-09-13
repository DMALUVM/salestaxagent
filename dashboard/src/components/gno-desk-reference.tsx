"use client";

import { useMemo, useState } from "react";
import { BookOpen, ExternalLink, Scale, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  GNO_SOURCE_DOCS,
  TALLOWBOURN_PPC_DESK,
  filterGnoRules,
  type GnoRuleCategory,
} from "@/lib/gno-methodology";
import type { GnoLedgerRow } from "@/lib/gno-learning";

const CATEGORIES: Array<{ id: "all" | GnoRuleCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "desk", label: "Desk" },
  { id: "economics", label: "Economics" },
  { id: "placements", label: "Placements" },
  { id: "harvesting", label: "Harvesting" },
  { id: "structure", label: "Structure" },
  { id: "outcomes", label: "Outcomes" },
];

export function GnoDeskReference({ ledger }: { ledger: GnoLedgerRow[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const rules = useMemo(() => filterGnoRules(query, category), [query, category]);

  return (
    <Card className="border-amber-200/70 bg-amber-50/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4" />
          GNO rules, source docs, and outcome ledger
        </CardTitle>
        <CardDescription>
          Curated from the tallowbourn-ppc methodology and this desk&apos;s harvest ledger. Family
          CM break-even (lip 42% / deo 36% / balm 36%) stays the SoT. Open the PPC-only advisor for
          the 152-source library, SKU economics, and execution center — do not clone that desk here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <a
            href={TALLOWBOURN_PPC_DESK.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            Open tallowbourn-ppc (deep advisor)
            <ExternalLink className="h-3 w-3" />
          </a>
          <span className="text-muted-foreground">· {TALLOWBOURN_PPC_DESK.why}</span>
        </div>

        <Tabs defaultValue="rules">
          <TabsList className="flex h-auto flex-wrap justify-start gap-1">
            <TabsTrigger value="rules">
              <Scale className="mr-1 h-3.5 w-3.5" />
              Decision rules
            </TabsTrigger>
            <TabsTrigger value="docs">Source docs</TabsTrigger>
            <TabsTrigger value="ledger">
              <ScrollText className="mr-1 h-3.5 w-3.5" />
              Outcome ledger
            </TabsTrigger>
          </TabsList>

          <TabsContent value="rules" className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search rules (harvest, TOS, family CM…)"
                className="max-w-sm"
              />
              {CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCategory(item.id)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    category === item.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-md border bg-background p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{rule.category}</Badge>
                    <span className="font-medium">{rule.title}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{rule.practice}</p>
                  <p className="mt-1 text-xs">
                    <span className="font-medium">Basis:</span> {rule.basis}
                  </p>
                  <p className="mt-1 text-xs">
                    <span className="font-medium">On this desk:</span> {rule.application}
                  </p>
                </div>
              ))}
              {rules.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rules match that filter.</p>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="docs" className="space-y-2">
            {GNO_SOURCE_DOCS.map((doc) => (
              <div key={doc.id} className="rounded-md border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{doc.kind}</Badge>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {doc.title}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="mt-1 text-muted-foreground">{doc.note}</p>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="ledger" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Last {ledger.length} harvest-desk decisions (hold / bid_down / bid_up / skip /
              approve_harvest_neg). Full execution-center history stays on tallowbourn-ppc.
            </p>
            {ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ledger rows yet. Use the outcome paste below — that write is local
                learning only.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5">When</th>
                      <th className="px-2 py-1.5">Action</th>
                      <th className="px-2 py-1.5">Term</th>
                      <th className="px-2 py-1.5">Campaign</th>
                      <th className="px-2 py-1.5">Tag</th>
                      <th className="px-2 py-1.5">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((row) => (
                      <tr key={row.id ?? `${row.created_at}-${row.search_term}-${row.dave_action}`} className="border-t">
                        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                          {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge variant="secondary">{row.dave_action}</Badge>
                        </td>
                        <td className="px-2 py-1.5">{row.search_term || "—"}</td>
                        <td className="max-w-[220px] truncate px-2 py-1.5" title={row.campaign_name || ""}>
                          {row.campaign_name || "—"}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{row.proposed_tag || "—"}</td>
                        <td className="max-w-[240px] truncate px-2 py-1.5 text-muted-foreground" title={row.notes || ""}>
                          {row.notes || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
