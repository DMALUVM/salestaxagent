"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ClipboardCopy, Download } from "lucide-react";
import { grokPromptFor, recTypeOfWeekly, weeklyToCsv, WEEKLY_GROK_PROMPT, type WeeklyPayload, type WeeklyRow, type WeeklyStatus } from "@/lib/ppc-weekly";

function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type BleederNotice = { kind: "success" | "warn" | "error"; text: string };

function toUiStatus(row: WeeklyRow, local: Record<string, WeeklyStatus>): WeeklyStatus {
  return local[row.id] ?? row.status;
}

export function PpcBleeders({
  data,
  onNotice,
  onMarked,
}: {
  data: WeeklyPayload | null | undefined;
  onNotice?: (n: BleederNotice) => void;
  onMarked?: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "done" | "skipped" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, WeeklyStatus>>({});
  const [copied, setCopied] = useState(false);

  const rows = data?.rows ?? [];
  const shown = useMemo(() => {
    return rows.filter((r) => {
      const status = toUiStatus(r, local);
      if (filter === "all") return true;
      return status === filter;
    });
  }, [rows, filter, local]);

  const openCount = rows.filter((r) => toUiStatus(r, local) === "open").length;
  const doneCount = rows.filter((r) => toUiStatus(r, local) === "done").length;
  const skippedCount = rows.filter((r) => toUiStatus(r, local) === "skipped").length;

  async function mark(row: WeeklyRow, next: WeeklyStatus) {
    const status = next === "done" ? "applied" : next === "skipped" ? "dismissed" : "open";
    setBusy(row.id);
    try {
      const resp = await fetch("/api/ppc/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          bleeder: {
            checklist_id: row.id,
            as_of: data?.window.search.end ?? "",
            rec_type: recTypeOfWeekly(row.action),
            action_type: row.action,
            campaign_id: row.campaign_id,
            campaign_name: row.campaign,
            search_term: row.term,
            impact_estimate: row.spend,
            evidence: {
              why: row.why,
              clicks: row.clicks,
              spend: row.spend,
              sales: row.sales,
              lock: "campaign+term+action 7d unless still $0",
            },
            suggested_action: row.why,
          },
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result.ok === false) {
        onNotice?.({ kind: "error", text: result.error ?? `Could not mark (${resp.status}).` });
        return;
      }
      setLocal((m) => ({ ...m, [row.id]: next }));
      onMarked?.();
      onNotice?.({
        kind: result.decisionLogged === false ? "warn" : "success",
        text: next === "done"
          ? "Marked Done. Recorded on ads_action_decisions — 7-day lock, nothing writes to Amazon."
          : next === "skipped"
            ? "Marked Skipped. Recorded dismissed_at — 7-day lock, nothing writes to Amazon."
            : "Reopened.",
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

  function exportCsv() {
    const csv = weeklyToCsv(shown);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppc-weekly-${data?.window.search.end || "empty"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotice?.({ kind: "success", text: `Downloaded ${a.download} — ${shown.length} row(s).` });
  }

  async function copyPrompt() {
    const text = data?.execute_list === "blake_24d"
      ? grokPromptFor("blake_24d")
      : (data?.grok_prompt ?? WEEKLY_GROK_PROMPT);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onNotice?.({
        kind: "success",
        text: data?.execute_list === "blake_24d"
          ? "24d execute prompt copied. This week CSV is the execute list. Nothing writes to Amazon."
          : "24d execute prompt copied. Window 2026-08-06..08-29. Do not wait for 90d. Nothing writes to Amazon.",
      });
    } catch (e) {
      onNotice?.({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not copy the prompt.",
      });
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          This week&apos;s list did not load.
        </CardContent>
      </Card>
    );
  }

  const waiting = data.execute_list === "empty" && !data.execute_ready;
  const blakeReady = data.execute_list === "blake_24d";

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2 p-4 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {blakeReady ? "This week — 24d Blake-ranked list" : "This week — empty until 90d search terms"}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {data.window_chip ? <Badge variant="outline">{data.window_chip}</Badge> : null}
                <Badge variant="outline">{data.window.search.label}</Badge>
              </div>
              <p className="mt-0.5 text-muted-foreground">
                Search terms <span className="font-medium text-foreground">{data.window.search.label}</span>
                {data.window.placement
                  ? <>{" · "}Placements <span className="font-medium text-foreground">{data.window.placement.label}</span></>
                  : null}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={copyPrompt}>
                <ClipboardCopy className="mr-1 h-3 w-3" />
                {copied ? "Prompt copied" : "Copy Grok prompt"}
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Download className="mr-1 h-3 w-3" />
                Export CSV
              </Button>
            </div>
          </div>
          <p className="text-sm text-foreground">
            {blakeReady
              ? "24d Blake-ranked list for 2026-08-06..08-29. Mark Done or Skipped after Seller Central. 90d backfill continues for next Monday. Nothing writes to Amazon."
              : waiting
                ? "No execute list this week. Wait for Dana's new min/max on ads_search_terms_daily after the Sunday 90d pull. Blake ranks then."
                : "90d search-term window is present. Execute list stays empty until Blake ranks. No auto-seed."}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
            <span>Account CVR <strong className="text-foreground">{data.account_cvr}%</strong></span>
            <span>Branded lane <strong className="text-foreground">{data.account_cvr_branded ?? "—"}%</strong></span>
            <span>Non-branded lane <strong className="text-foreground">{data.account_cvr_nonbranded ?? "—"}%</strong></span>
            <span>Click floor <strong className="text-foreground">{data.click_floor}</strong></span>
            <span>Open <strong className="text-foreground">{openCount}</strong></span>
            <span>Done <strong className="text-emerald-700 dark:text-emerald-400">{doneCount}</strong></span>
            <span>Skipped <strong className="text-muted-foreground">{skippedCount}</strong></span>
          </div>
          <p className="text-muted-foreground">
            new_bid down = {data.new_bid.down}. new_bid up = {data.new_bid.up}.
            current_bid is always blank. Done/Skipped lock campaign+term+action for {data.lock.days} days
            ({data.lock.exception}). Nothing writes to Amazon.
          </p>
          <div className="space-y-0.5 text-muted-foreground">
            {data.cadence.map((n) => <p key={n}>{n}</p>)}
            {data.hold.map((n) => <p key={n}>HOLD: {n}</p>)}
          </div>
          {data.notes.slice(0, 3).map((n) => (
            <p key={n.slice(0, 48)} className="text-[11px] text-muted-foreground">{n}</p>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <p className="text-xs font-medium text-foreground">Standing Grok prompt</p>
          <textarea
            readOnly
            value={data.grok_prompt}
            className="h-40 w-full resize-y rounded-md border bg-muted/40 p-2 font-mono text-[11px] text-foreground"
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {([
            ["open", `Open (${openCount})`],
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
              {rows.length === 0
                ? "Empty execute table. CSV headers and Done/Skipped wiring are ready."
                : filter === "open" ? "No open rows." : "No rows in this filter."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Done / Skipped</TableHead>
                  <TableHead>Rank</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Ad group</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">ACOS</TableHead>
                  <TableHead className="text-right">Term CVR</TableHead>
                  <TableHead className="text-right">Lane CVR</TableHead>
                  <TableHead className="text-right">current_bid</TableHead>
                  <TableHead className="text-right">new_bid</TableHead>
                  <TableHead>Placement</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead className="min-w-[16rem]">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const status = toUiStatus(r, local);
                  return (
                    <TableRow key={r.id} className={status !== "open" ? "opacity-60" : ""}>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant={status === "done" ? "default" : "outline"}
                            size="sm"
                            disabled={busy === r.id}
                            onClick={() => mark(r, "done")}
                          >
                            Done
                          </Button>
                          <Button
                            variant={status === "skipped" ? "default" : "outline"}
                            size="sm"
                            disabled={busy === r.id}
                            onClick={() => mark(r, "skipped")}
                          >
                            Skipped
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{r.rank}</Badge></TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{r.action}</TableCell>
                      <TableCell className="text-xs max-w-[12rem] truncate" title={r.campaign}>{r.campaign}</TableCell>
                      <TableCell className="text-xs max-w-[10rem] truncate">{r.ad_group || "—"}</TableCell>
                      <TableCell className="text-xs max-w-[10rem] truncate">{r.term || "—"}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{r.match_type || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.clicks}</TableCell>
                      <TableCell className="text-right tabular-nums">${fmtD(r.spend)}</TableCell>
                      <TableCell className="text-right tabular-nums">${fmtD(r.sales)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.acos == null ? "—" : `${r.acos}%`}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.term_cvr == null ? "—" : `${r.term_cvr.toFixed(1)}%`}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.account_cvr_lane == null ? "—" : `${r.account_cvr_lane.toFixed(1)}%`}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">—</TableCell>
                      <TableCell className="text-right tabular-nums">{r.new_bid == null ? "—" : `$${fmtD(r.new_bid)}`}</TableCell>
                      <TableCell className="text-xs">{r.placement || "—"}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap">{r.window}</TableCell>
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
