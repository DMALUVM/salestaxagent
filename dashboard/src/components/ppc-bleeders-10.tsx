"use client";

import { Fragment, useMemo, useState } from "react";
import { ClipboardCopy } from "lucide-react";
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

/** Full name + one-click copy for Campaign Manager paste. */
function CopyableName({
  value,
  label,
  compact,
  hint,
}: {
  value: string;
  label: string;
  compact?: boolean;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = value.trim();
  if (!text) {
    return <span className="text-muted-foreground">—</span>;
  }

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`flex min-w-0 items-start gap-1 overflow-hidden ${compact ? "max-w-[12rem]" : "max-w-[18rem]"}`}>
      <div className="min-w-0 overflow-hidden">
        <span className="font-mono text-xs whitespace-normal break-words select-all leading-snug">
          {text}
        </span>
        {hint ? (
          <p className="mt-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">{hint}</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size={copied ? "xs" : "icon-xs"}
        className="mt-0.5 shrink-0 text-muted-foreground"
        title={copied ? `${label} copied` : `Copy ${label}`}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={copy}
      >
        {copied
          ? <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">Copied</span>
          : <ClipboardCopy className="h-3 w-3" />}
      </Button>
    </div>
  );
}

/** One copyable campaign name. A second copy block only when id is a distinct SP-API id. */
function CampaignIdentity({ name, id }: { name: string; id: string }) {
  const idDiffers = Boolean(id && id !== name);
  return (
    <div className="min-w-0 max-w-[18rem] overflow-hidden">
      <CopyableName value={name} label="campaign name" />
      {idDiffers ? (
        <div className="mt-1">
          <p className="text-[10px] text-muted-foreground">Campaign ID</p>
          <CopyableName value={id} label="campaign id" compact />
        </div>
      ) : id ? (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Campaign ID same as name (no SP-API id on pasted 1.0)
        </p>
      ) : null}
    </div>
  );
}

function AdsVerifyNote({ note }: { note: string }) {
  return (
    <div className="bleeders-10-verify-note rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
      <p className="whitespace-normal break-words text-[11px] leading-snug text-amber-800 dark:text-amber-300">
        {note}
      </p>
    </div>
  );
}

/** Display-only: Why text should repeat the same clicks/spend as the columns. */
function whyMetricsMatch(row: Bleeders10Row): boolean {
  if (!row.why.includes(`${row.clicks} click`)) return false;
  const spend = row.spend.toFixed(2);
  return row.why.includes(spend) || row.why.includes(String(row.spend));
}

const TABLE_COL_COUNT = 14;

type Status = Bleeders10Row["status"];

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
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

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
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 space-y-0.5">
            <p className="text-xs font-medium text-foreground">
              Verify in Amazon Ads → Reports → Search term before pause/negate
            </p>
            <p className="tabular-nums text-[11px] text-muted-foreground">
              {data.window.window_start} to {data.window.window_end}
              {" "}({data.window.window_days}d, {data.search_term_coverage})
              {" · "}as of {data.window.as_of}
              {" · "}source {data.account_cvr_source}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Reconcile campaign name/id, ad group, term, match, clicks, orders,
              sales, and spend to that report. Orders and Sales come from payload
              fields — this page does not infer them from Why. {BLEEDERS_10_VERIFY}
            </p>
            <p className="text-[11px] text-foreground">
              <span className="text-muted-foreground">Ads snapshot:</span>{" "}
              {data.ads_snapshot?.pulled_at
                ? `keywords ${data.ads_snapshot.keywords_count} · negatives ${data.ads_snapshot.negatives_count} · pulled_at ${data.ads_snapshot.pulled_at}`
                : "not loaded"}
              {alreadyAppliedCount ? ` · ${alreadyAppliedCount} already applied in Ads` : ""}
            </p>
            {data.ads_snapshot?.warning ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">{data.ads_snapshot.warning}</p>
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
            <>
            <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2">
              <p className="text-xs font-medium text-foreground">
                Verify in Amazon Ads → Reports → Search term
              </p>
              <p className="tabular-nums text-[11px] text-muted-foreground">
                {data.window.window_start} to {data.window.window_end}
                {" "}({data.window.window_days}d, {data.search_term_coverage})
                {" · "}as of {data.window.as_of}
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Done / Skipped</TableHead>
                  <TableHead>Rank</TableHead>
                  <TableHead className="min-w-[22rem]">Action + how-to</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Ad group</TableHead>
                  <TableHead>Search term</TableHead>
                  <TableHead>Keyword / targeting</TableHead>
                  <TableHead className="text-right">SS Vol</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right" title="Window order count from payload (orders)">Orders</TableHead>
                  <TableHead className="text-right" title="Attributed sales dollars from payload (sales_14d)">Sales</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="min-w-[16rem]">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const status = local[r.checklist_id] ?? r.status;
                  const sameExact = r.action === "pause_keyword"
                    && bleeders10TermsEqual(r.search_term, r.keyword);
                  const evidenceOpen = openEvidence === r.checklist_id;
                  const metricsOk = whyMetricsMatch(r);
                  return (
                    <Fragment key={r.checklist_id}>
                    <TableRow className={status !== "open" ? "opacity-60" : ""}>
                      <TableCell className="align-top w-36 overflow-hidden whitespace-normal">
                        <div className="flex flex-col gap-1.5">
                          {status === "already_applied" ? (
                            <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-400">
                              Already applied in Ads
                            </Badge>
                          ) : null}
                          <div className="flex flex-wrap gap-1">
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="w-fit"
                            onClick={() => setOpenEvidence(evidenceOpen ? null : r.checklist_id)}
                          >
                            {evidenceOpen ? "Hide evidence" : "Evidence"}
                          </Button>
                          {r.applied_reason && status !== "open" ? (
                            <p className="max-w-[10rem] overflow-hidden whitespace-normal break-words text-[10px] leading-snug text-muted-foreground">{r.applied_reason}</p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="align-top"><Badge variant="outline" className="text-[10px]">{r.rank}</Badge></TableCell>
                      <TableCell className="align-top min-w-[22rem] max-w-[28rem] overflow-hidden whitespace-normal">
                        <p className="text-xs font-medium leading-snug text-foreground">{r.action_label}</p>
                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{r.suggested_action}</p>
                      </TableCell>
                      <TableCell className="align-top overflow-hidden whitespace-normal">
                        <CampaignIdentity name={r.campaign_name} id={r.campaign_id} />
                      </TableCell>
                      <TableCell className="align-top overflow-hidden whitespace-normal">
                        <CopyableName value={r.ad_group_name} label="ad group name" />
                      </TableCell>
                      <TableCell className="align-top overflow-hidden whitespace-normal">
                        <CopyableName value={r.search_term} label="search term" />
                      </TableCell>
                      <TableCell className="align-top overflow-hidden whitespace-normal">
                        <CopyableName
                          value={r.keyword ?? ""}
                          label="keyword"
                          hint={sameExact ? "same Exact KW as the search term" : undefined}
                        />
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums text-xs text-muted-foreground" title="SoldScope search volume when stored">
                        {formatSoldScopeVol(r.soldscope_sv)}
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <CopyableName value={r.match_type} label="match type" compact />
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">{r.clicks}</TableCell>
                      <TableCell className="align-top text-right tabular-nums">{r.orders}</TableCell>
                      <TableCell className="align-top text-right tabular-nums">${fmtD(r.sales_14d)}</TableCell>
                      <TableCell className="align-top text-right tabular-nums">${fmtD(r.spend)}</TableCell>
                      <TableCell className="align-top max-w-[18rem] overflow-hidden whitespace-normal text-[11px] leading-snug">
                        <p className="mb-1 text-[10px] text-muted-foreground">
                          Verify in Ads: SP Search Term report,
                          campaign {r.campaign_name || "?"}, term {r.search_term || "?"}.
                        </p>
                        {!metricsOk ? (
                          <p className="mb-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            Why text does not match clicks/spend columns — trust the columns.
                          </p>
                        ) : null}
                        {r.why}
                      </TableCell>
                    </TableRow>
                    {status === "open" && r.ads_verify_note ? (
                      <TableRow className="bg-amber-500/5 hover:bg-amber-500/5">
                        <TableCell colSpan={TABLE_COL_COUNT} className="overflow-hidden whitespace-normal py-2">
                          <AdsVerifyNote note={r.ads_verify_note} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {evidenceOpen ? (
                      <TableRow className="bg-muted/40">
                        <TableCell colSpan={TABLE_COL_COUNT} className="whitespace-normal">
                          <div className="grid gap-1 p-1 font-mono text-[11px] tabular-nums text-muted-foreground sm:grid-cols-2">
                            <p>window {data.window.window_start} .. {data.window.window_end} as_of {data.window.as_of}</p>
                            <p>source SP Search Term ({data.search_term_coverage})</p>
                            <p>campaign_name {r.campaign_name || "—"}</p>
                            <p>campaign_id {r.campaign_id || "—"}</p>
                            <p>ad_group_name {r.ad_group_name || "—"}</p>
                            <p>ad_group_id {r.ad_group_id || "—"}</p>
                            <p>search_term {r.search_term || "—"}</p>
                            <p>keyword {r.keyword || "—"}</p>
                            <p>match_type {r.match_type || "—"}</p>
                            <p>clicks {r.clicks}</p>
                            <p>orders {r.orders}</p>
                            <p>sales_14d {r.sales_14d}</p>
                            <p>spend {r.spend}</p>
                            <p>term_cvr {r.term_cvr}</p>
                            <p>action {r.action_label || r.action}</p>
                            <p>status {status}</p>
                            <p className="sm:col-span-2">
                              Verify in Ads: SP Search Term report for {data.window.window_start}..{data.window.window_end},
                              campaign {r.campaign_name || "?"}, term {r.search_term || "?"}.
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
