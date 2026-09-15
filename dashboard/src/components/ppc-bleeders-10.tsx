"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  BLEEDERS_10_BLURB,
  BLEEDERS_10_TITLE,
  BLEEDERS_10_VERIFY,
  bleeders10TermsEqual,
  recTypeOfBleeders10,
  type Bleeders10Payload,
  type Bleeders10Row,
} from "@/lib/ppc-bleeders-10";
import { formatSoldScopeVol } from "@/lib/soldscope-status";

function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Status = Bleeders10Row["status"];

function CopyValue({
  value,
  hint,
}: {
  value: string | null | undefined;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = String(value ?? "").trim();
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard can be blocked; value stays visible */
    }
  }
  return (
    <div className="min-w-[8rem] max-w-[14rem]">
      <button
        type="button"
        onClick={copy}
        title={text ? `Copy ${text}` : "Nothing to copy"}
        className="text-left text-xs font-medium text-foreground break-words hover:underline"
      >
        {text || "—"}{" "}
        <span className="text-[10px] font-normal text-muted-foreground">
          {copied ? "copied" : text ? "⧉" : ""}
        </span>
      </button>
      {hint ? (
        <p className="mt-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">{hint}</p>
      ) : null}
    </div>
  );
}

export function PpcBleeders10({
  data,
  onNotice,
  onMarked,
}: {
  data: Bleeders10Payload | null | undefined;
  onNotice?: (n: { kind: "success" | "warn" | "error"; text: string }) => void;
  onMarked?: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "already_applied" | "done" | "skipped" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, Status>>({});

  const rows = data?.rows ?? [];
  const shown = useMemo(() => {
    return rows.filter((r) => {
      const status = local[r.checklist_id] ?? r.status;
      if (filter === "all") return true;
      if (filter === "done") return status === "done";
      return status === filter;
    });
  }, [rows, filter, local]);

  const openCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "open").length;
  const alreadyAppliedCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "already_applied").length;
  const doneCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "done").length;
  const skippedCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "skipped").length;

  async function mark(row: Bleeders10Row, next: Status) {
    const status = next === "done" ? "applied" : next === "skipped" ? "dismissed" : "open";
    setBusy(row.checklist_id);
    try {
      const resp = await fetch("/api/ppc/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          bleeder: {
            checklist_id: row.checklist_id,
            as_of: data?.window.window_end ?? "2026-08-31",
            rec_type: recTypeOfBleeders10(row.action),
            action_type: row.action,
            campaign_id: row.campaign_id || row.campaign_name,
            campaign_name: row.campaign_name,
            search_term: row.search_term,
            impact_estimate: row.spend,
            evidence: {
              why: row.why,
              action_label: row.action_label,
              suggested_action: row.suggested_action,
              keyword: row.keyword,
              clicks: row.clicks,
              spend: row.spend,
              sales: row.sales_14d,
              version: "1.0",
            },
            suggested_action: row.suggested_action,
          },
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result.ok === false) {
        onNotice?.({ kind: "error", text: result.error ?? `Could not mark (${resp.status}).` });
        return;
      }
      setLocal((m) => ({ ...m, [row.checklist_id]: next }));
      onMarked?.();
      onNotice?.({
        kind: result.decisionLogged === false ? "warn" : "success",
        text: next === "done"
          ? "Marked Done on Bleeders 1.0. Recorded on ads_action_decisions — nothing writes to Amazon."
          : "Marked Skipped on Bleeders 1.0. Nothing writes to Amazon.",
      });
    } catch (e) {
      onNotice?.({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not record that mark.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <Card id="ppc-bleeders-10" className="scroll-mt-14 border-amber-500/30">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Bleeders 1.0 did not load.
        </CardContent>
      </Card>
    );
  }

  return (
    <div id="ppc-bleeders-10" className="scroll-mt-14 space-y-3">
      <Card className="border-amber-500/40">
        <CardContent className="space-y-2 p-4 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">{BLEEDERS_10_TITLE}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">1.0</Badge>
                <Badge variant="outline">{data.window.label}</Badge>
                <Badge variant="outline">nonbrand ST CVR {data.account_cvr}%</Badge>
                <Badge variant="outline">floor {data.click_floor}</Badge>
              </div>
            </div>
            <span className="tabular-nums text-muted-foreground">
              Open <strong className="text-foreground">{openCount}</strong>
            </span>
          </div>
          <p className="text-sm text-foreground">{BLEEDERS_10_BLURB}</p>
          <div className="space-y-0.5 rounded-md border bg-muted/40 p-2 text-[11px] text-foreground">
            <p><span className="text-muted-foreground">Window:</span> {data.window.label}</p>
            <p><span className="text-muted-foreground">Campaign:</span> listed on each row — open that campaign in Ads to verify.</p>
            <p>{BLEEDERS_10_VERIFY}</p>
            <p>
              <span className="text-muted-foreground">Ads snapshot:</span>{" "}
              {data.ads_snapshot?.pulled_at
                ? `keywords ${data.ads_snapshot.keywords_count} · negatives ${data.ads_snapshot.negatives_count} · pulled_at ${data.ads_snapshot.pulled_at}`
                : "not loaded"}
              {alreadyAppliedCount ? ` · ${alreadyAppliedCount} already applied in Ads` : ""}
            </p>
            {data.ads_snapshot?.warning ? (
              <p className="text-amber-700 dark:text-amber-400">{data.ads_snapshot.warning}</p>
            ) : null}
          </div>
          {data.notes.filter((n) => n !== BLEEDERS_10_BLURB).slice(0, 3).map((n) => (
            <p key={n.slice(0, 48)} className="text-[11px] text-muted-foreground">{n}</p>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {([
            ["open", `Open (${openCount})`],
            ["already_applied", `Already applied (${alreadyAppliedCount})`],
            ["done", `Done (${doneCount})`],
            ["skipped", `Skipped (${skippedCount})`],
            ["all", `All (${rows.length})`],
          ] as const).map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                filter === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {shown.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? "Bleeders 1.0 list did not load." : "No rows in this filter."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Done / Skipped</TableHead>
                  <TableHead>Rank</TableHead>
                  <TableHead className="min-w-[22rem]">Action + how-to</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Ad group</TableHead>
                  <TableHead>Search term</TableHead>
                  <TableHead>Keyword / targeting</TableHead>
                  <TableHead className="text-right">SS Vol</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="min-w-[16rem]">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const status = local[r.checklist_id] ?? r.status;
                  const sameExact = r.action === "pause_keyword"
                    && bleeders10TermsEqual(r.search_term, r.keyword);
                  return (
                    <TableRow key={r.checklist_id} className={status !== "open" ? "opacity-60" : ""}>
                      <TableCell>
                        <div className="space-y-1">
                          {status === "already_applied" ? (
                            <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-400">
                              Already applied in Ads
                            </Badge>
                          ) : null}
                          <div className="flex gap-1">
                            <Button
                              variant={status === "done" ? "default" : "outline"}
                              size="sm"
                              disabled={busy === r.checklist_id}
                              onClick={() => mark(r, "done")}
                            >
                              Done
                            </Button>
                            <Button
                              variant={status === "skipped" ? "default" : "outline"}
                              size="sm"
                              disabled={busy === r.checklist_id}
                              onClick={() => mark(r, "skipped")}
                            >
                              Skipped
                            </Button>
                          </div>
                          {r.applied_reason && status !== "open" ? (
                            <p className="max-w-[12rem] text-[10px] leading-snug text-muted-foreground">{r.applied_reason}</p>
                          ) : null}
                          {status === "open" && r.ads_verify_note ? (
                            <p className="max-w-[12rem] text-[10px] leading-snug text-amber-700 dark:text-amber-400">{r.ads_verify_note}</p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{r.rank}</Badge></TableCell>
                      <TableCell className="min-w-[22rem] max-w-[28rem] whitespace-normal">
                        <p className="text-xs font-medium text-foreground">{r.action_label}</p>
                        <p className="mt-1 text-[11px] leading-snug text-foreground/90">{r.suggested_action}</p>
                      </TableCell>
                      <TableCell className="text-xs max-w-[12rem] truncate" title={r.campaign_name}>
                        {r.campaign_name}
                      </TableCell>
                      <TableCell className="text-xs max-w-[10rem] truncate">{r.ad_group_name || "—"}</TableCell>
                      <TableCell>
                        <CopyValue value={r.search_term} />
                      </TableCell>
                      <TableCell>
                        <CopyValue
                          value={r.keyword}
                          hint={sameExact ? "same Exact KW as the search term" : undefined}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs text-muted-foreground" title="SoldScope search volume when stored">
                        {formatSoldScopeVol(r.soldscope_sv)}
                      </TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{r.match_type || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.clicks}</TableCell>
                      <TableCell className="text-right tabular-nums">${fmtD(r.spend)}</TableCell>
                      <TableCell className="text-[11px] whitespace-normal max-w-[18rem]">{r.why}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
