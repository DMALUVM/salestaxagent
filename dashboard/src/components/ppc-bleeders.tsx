"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Download } from "lucide-react";
import type { BleederRow, BleedersPayload } from "@/lib/ppc-bleeders";

function bleedersToCsv(rows: BleederRow[]): string {
  const headers = [
    "checklist_id", "as_of", "window_start", "window_end", "window_days",
    "rank", "action", "campaign_name", "campaign_id", "ad_group_name",
    "ad_group_id", "search_term", "keyword", "product_target", "match_type",
    "clicks", "spend", "sales_14d", "orders", "term_cvr", "acos",
    "account_cvr", "account_cvr_branded", "account_cvr_nonbranded", "lane",
    "click_floor", "gno_10_0", "why", "priority", "status",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => esc((r as unknown as Record<string, unknown>)[h])).join(","));
  }
  return lines.join("\n");
}

function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const RANK_TONE: Record<string, string> = {
  R1: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  R2: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  R3: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
};

const ACTION_TONE: Record<string, string> = {
  negative_exact: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  pause_keyword: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  pause_target: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
};

const PRIORITY_TONE: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800",
  P1: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800",
};

export type BleederNotice = { kind: "success" | "warn" | "error"; text: string };

export function PpcBleeders({
  data,
  onNotice,
  onMarked,
}: {
  data: BleedersPayload | null | undefined;
  onNotice?: (n: BleederNotice) => void;
  onMarked?: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, "open" | "done">>({});

  const rows = data?.rows ?? [];
  const shown = useMemo(() => {
    return rows.filter((r) => {
      const status = local[r.checklist_id] ?? r.status;
      if (filter === "all") return true;
      return status === filter;
    });
  }, [rows, filter, local]);

  const openCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "open").length;
  const doneCount = rows.filter((r) => (local[r.checklist_id] ?? r.status) === "done").length;

  async function toggle(row: BleederRow, checked: boolean) {
    const status = checked ? "applied" : "open";
    setBusy(row.checklist_id);
    try {
      const resp = await fetch("/api/ppc/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          bleeder: {
            checklist_id: row.checklist_id,
            as_of: row.as_of,
            rec_type: row.action === "pause_keyword"
              ? "BLEEDER_PAUSE_KEYWORD"
              : row.action === "pause_target"
                ? "BLEEDER_PAUSE_TARGET"
                : "BLEEDER_NEGATIVE_EXACT",
            action_type: row.action,
            campaign_id: row.campaign_id,
            campaign_name: row.campaign_name,
            ad_group_id: row.ad_group_id,
            entity_type: row.action === "pause_target" ? "product_target" : row.action === "pause_keyword" ? "keyword" : "search_term",
            search_term: row.search_term,
            priority: row.priority,
            impact_estimate: row.spend,
            evidence: {
              why: row.why,
              clicks: row.clicks,
              spend: row.spend,
              sales_14d: row.sales_14d,
              orders: row.orders,
              term_cvr: row.term_cvr,
              account_cvr: row.account_cvr,
              account_cvr_branded: row.account_cvr_branded,
              account_cvr_nonbranded: row.account_cvr_nonbranded,
              lane: row.lane,
              click_floor: row.click_floor,
              gno_10_0: row.gno_10_0,
              rank: row.rank,
              match_type: row.match_type,
              window_start: row.window_start,
              window_end: row.window_end,
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
      setLocal((m) => ({ ...m, [row.checklist_id]: checked ? "done" : "open" }));
      onMarked?.();
      onNotice?.({
        kind: result.decisionLogged === false ? "warn" : "success",
        text: checked
          ? "Marked done. Recorded on ads_action_decisions — nothing writes to Amazon."
          : "Reopened. Blake still sees this as open.",
      });
    } catch (e) {
      onNotice?.({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not record that checkbox.",
      });
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    const csv = bleedersToCsv(shown);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppc-bleeders-${data?.window.window_end ?? "window"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotice?.({ kind: "success", text: `Downloaded ${a.download} — ${shown.length} row(s).` });
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Bleeders did not load.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2 p-4 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Bleeders checklist</p>
              <p className="mt-0.5 text-muted-foreground">
                Window <span className="font-medium text-foreground">{data.window.label}</span>
                {" · "}as of {data.window.as_of || "—"}
                {" · "}{data.window.window_days}d labeled until the Sunday 90d search-term backfill lands.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!shown.length}>
              <Download className="mr-1 h-3 w-3" />
              Export CSV
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
            <span>Account CVR <strong className="text-foreground">{data.account_cvr}%</strong> (campaigns, same window)</span>
            <span>Branded lane <strong className="text-foreground">{data.account_cvr_branded ?? "—"}%</strong></span>
            <span>Non-branded lane <strong className="text-foreground">{data.account_cvr_nonbranded ?? "—"}%</strong></span>
            <span>Click floor <strong className="text-foreground">{data.click_floor}</strong></span>
            <span>Open <strong className="text-foreground">{openCount}</strong></span>
            <span>Done <strong className="text-emerald-700 dark:text-emerald-400">{doneCount}</strong></span>
          </div>
          <p className="text-muted-foreground">
            Cut bar = term CVR below that row&apos;s lane account CVR. Zero-sales rows that meet the floor are P0 / R1.
            10/$0 is the R3 flag, not the only filter. Search-term reports are <strong>SP-only</strong> — SB/SD terms will be thin.
            Checkboxes persist completion; they do not edit Amazon.
          </p>
          {data.notes.slice(0, 2).map((n) => (
            <p key={n.slice(0, 40)} className="text-[11px] text-muted-foreground">{n}</p>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {([
            ["open", `Open (${openCount})`],
            ["done", `Done (${doneCount})`],
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
                ? "No bleeders in the stored search-term window."
                : filter === "open" ? "No open bleeders — Blake sees them under Done." : "No rows in this filter."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">Done</TableHead>
                  <TableHead className="w-12">Rank</TableHead>
                  <TableHead className="w-12">Pri</TableHead>
                  <TableHead className="w-28">Action</TableHead>
                  <TableHead>Campaign / ad group</TableHead>
                  <TableHead>Term / KW / target</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Orders / sales</TableHead>
                  <TableHead className="text-right">Term CVR</TableHead>
                  <TableHead className="text-right">Lane CVR</TableHead>
                  <TableHead className="text-right">Δ vs lane</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">ACOS</TableHead>
                  <TableHead>10/$0</TableHead>
                  <TableHead className="min-w-[18rem]">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const status = local[r.checklist_id] ?? r.status;
                  const done = status === "done";
                  const laneCvr = r.lane === "branded" ? r.account_cvr_branded : r.account_cvr_nonbranded;
                  const delta = laneCvr === null ? null : r.term_cvr - laneCvr;
                  const entity = r.search_term || r.keyword || r.product_target || "—";
                  return (
                    <TableRow key={r.checklist_id} className={done ? "opacity-60" : ""}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Mark ${entity} done`}
                          checked={done}
                          disabled={busy === r.checklist_id}
                          onChange={(e) => toggle(r, e.target.checked)}
                          className="h-4 w-4 accent-emerald-600"
                        />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${RANK_TONE[r.rank]}`}>{r.rank}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${PRIORITY_TONE[r.priority]}`}>{r.priority}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] whitespace-nowrap ${ACTION_TONE[r.action]}`}>
                          {r.action.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs max-w-[14rem]">
                        <div className="truncate font-medium" title={r.campaign_name}>{r.campaign_name}</div>
                        <div className="truncate text-muted-foreground" title={r.ad_group_name}>{r.ad_group_name || "—"}</div>
                      </TableCell>
                      <TableCell className="text-xs max-w-[12rem]">
                        <div className="truncate font-medium" title={entity}>{entity}</div>
                        <div className="text-[10px] text-muted-foreground">{r.lane} · acct {r.account_cvr}%</div>
                      </TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{r.match_type || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.clicks}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {r.orders} / ${fmtD(r.sales_14d)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.term_cvr.toFixed(1)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{laneCvr == null ? "—" : `${laneCvr.toFixed(1)}%`}</TableCell>
                      <TableCell className={`text-right tabular-nums ${delta !== null && delta < 0 ? "text-red-600" : ""}`}>
                        {delta === null ? "—" : `${delta.toFixed(1)}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">${fmtD(r.spend)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.acos == null ? "—" : `${r.acos}%`}</TableCell>
                      <TableCell>
                        {r.gno_10_0
                          ? <Badge variant="outline" className={`text-[10px] ${RANK_TONE.R3}`}>R3</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-[11px] whitespace-normal max-w-[22rem]">{r.why}</TableCell>
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
