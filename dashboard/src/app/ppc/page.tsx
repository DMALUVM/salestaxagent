"use client";

import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/loading";
import { SectionNav } from "@/components/section-nav";
import { rankBadgeOf } from "@/lib/ppc-actions";
import { SqpStatus } from "@/components/sqp-status";
import { BrandShare } from "@/components/brand-share";
import { PpcPlaybook } from "@/components/ppc-playbook";
import { isConfigured } from "@/lib/supabase";
import { Shield, Target, AlertTriangle, CheckCircle, X, RefreshCw, ChevronRight, Download, ClipboardCopy, Settings2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  ACTION_LABELS, ACTION_STYLES, actionTypeOf, doThisOf, whyOf,
  suggestedBidOf, matchTypesOf, adGroupsOf,
  buildPlanMarkdown, type RecLike,
} from "@/lib/ppc-actions";

function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtD(n: number) { return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

interface KPIs {
  spend: number; adSales: number; orders: number; clicks: number;
  impressions: number; acos: number; roas: number; cpc: number;
  cvr: number; totalSales: number; tacos: number;
}
interface DailyPoint {
  date: string; spend: number; ad_sales: number; orders: number;
  clicks: number; impressions: number; amazon_sales: number;
  /** null when the denominator is 0 — plotted as a gap, never as 0. */
  acos: number | null; roas: number | null; tacos: number | null;
}
interface CampaignAgg {
  campaign_name: string; spend: number; sales: number; orders: number;
  clicks: number; impressions: number; acos: number; roas: number; cvr: number;
  role: string;
  /** SP | SB | SD — which Amazon ad product this campaign belongs to. */
  campaign_type: string;
}
interface AdTypeAgg {
  type: string; label: string; campaigns: number;
  spend: number; sales: number; clicks: number; orders: number;
  spendSharePct: number; acos: number | null; cpc: number | null;
}
interface RoleAgg {
  role: string; label: string; description: string | null; campaigns: number;
  daysWithData: number;
  spend: number; sales: number; clicks: number; orders: number;
  budgetSharePct: number; acos: number | null; roas: number | null;
  cvr: number | null; tacos: number | null;
  targetSharePct: { min: number; max: number } | null;
  shareStatus: "above" | "below" | "in_range" | null;
}
interface RoleOther { spend: number; budgetSharePct: number; tacos: number | null }
interface RoleReconciliation {
  accountTacos: number | null; roleTacosSum: number | null; otherTacos: number;
  roleSpend: number; accountSpend: number; amazonSales: number;
}
interface RoleBucket { rows: RoleAgg[]; other: RoleOther | null; reconciliation: RoleReconciliation }
interface PlacementAgg {
  placement: string; spend: number; sales: number; clicks: number; orders: number;
  impressions: number; daysWithData: number; sharePct: number;
  acos: number | null; cvr: number | null; cpc: number | null;
}

/** Role badge tints — cool for finding demand, warm for spending on rank. */
const ROLE_STYLES: Record<string, string> = {
  discovery: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
  profit: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  ranking: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  defense: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
};
/** Ad-product badge. Deliberately a neutral/slate family so it reads as
 *  metadata and never competes with the role colours beside it. */
const AD_TYPE_STYLES: Record<string, string> = {
  SP: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
  SB: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  SD: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900",
};

const ROLE_BARS: Record<string, string> = {
  discovery: "bg-[#2a78d6] dark:bg-[#3987e5]",
  profit: "bg-[#12996a] dark:bg-[#199e70]",
  ranking: "bg-[#eb6834] dark:bg-[#d95926]",
  defense: "bg-[#4a3aa7] dark:bg-[#9085e9]",
};
/** One row per SEARCH TERM for the selected range — not one row per day. */
interface TermCampaign {
  campaign_id: string; campaign_name: string;
  spend: number; sales: number; orders: number; clicks: number;
  ad_groups: string[];
}
interface TermDay {
  date: string; spend: number; sales: number; orders: number; clicks: number;
}
interface SearchTerm {
  search_term: string;
  /** Normalized join key — the same one the organic-rank gate uses. */
  term_key: string;
  match_types: string[];
  spend: number; sales: number; orders: number; clicks: number; impressions: number;
  campaign_count: number;
  campaigns: TermCampaign[];
  days: TermDay[];
}
interface Rec {
  id: string; type: string; priority: string; impact_estimate: number;
  entity_type: string; entity_name: string; campaign_name: string;
  suggested_action: string;
  evidence: string | Record<string, unknown> | null; status: string;
}
interface PPCData {
  kpi7: KPIs | null; kpi7Days: number;
  kpi14: KPIs | null; kpi14Days: number;
  kpi30: KPIs | null; kpi30Days: number;
  kpi90: KPIs | null; kpi90Days: number;
  dailySeries: DailyPoint[];
  /** Server-computed window start dates, so chart and KPIs share one window. */
  cutoffs: Record<Range, string> | null;
  /** Yesterday in America/Los_Angeles — the newest closed reporting day. */
  asOf: string | null; today: string | null; adsThrough: string | null;
  dateMin: string | null; dateMax: string | null; daysInDb: number;
  campaigns: CampaignAgg[];
  /** One bucket per range — the server owns the bounds for both panels. */
  rolesByRange: Record<Range, RoleBucket> | null;
  adTypesByRange: Record<Range, AdTypeAgg[]> | null;
  /** Per-table load failures. Non-empty means "broken", not "no data". */
  loadErrors?: string[];
  fatalError?: string | null;
  spendScopeByRange: Record<Range, {
    total: number; placementSpend: number; unallocated: number;
    productsPresent: string[]; productsMissing: string[];
  }> | null;
  placementsByRange: Record<Range, PlacementAgg[]> | null;
  placementsAvailable: boolean;
  searchTerms: SearchTerm[];
  searchTermsByRange: Record<Range, SearchTerm[]> | null;
  recommendations: Rec[];
  /** Newest finished ads sync of any kind, plus which job and how it ended. */
  lastSync: string | null; lastSyncJob: string | null; lastSyncStatus: string | null;
  /** Last successful scheduled actions run — the queue refreshes on its own. */
  lastActions: string | null;
  /** Break-even target ACOS from the last actions run (not recomputed here). */
  targetAcos: number | null; targetAcosAsOf: string | null;
  /** Whether the target bands are file defaults or operator overrides. */
  strategy: { isCustom: boolean; storageAvailable: boolean; updatedAt: string | null } | null;
}

interface TargetBand { min: number; max: number }

/**
 * Target editor. Saves role spend-share bands through /api/ppc/settings, which
 * writes to Supabase with the service-role key server-side — the client never
 * gains new database access. Values are validated on the server; this dialog
 * mirrors the same checks so mistakes are caught before a round trip.
 */
function TargetsDialog({
  open, onOpenChange, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: (msg: Notice) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, TargetBand | null>>({});
  const [defaults, setDefaults] = useState<Record<string, TargetBand | null>>({});
  const [isCustom, setIsCustom] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The dialog is remounted each time it opens (see `key` at the call site),
  // so state starts fresh and this effect only fetches — no synchronous
  // setState resets, which would cascade a render on every open.
  useEffect(() => {
    if (!open) return;
    fetch("/api/ppc/settings").then((r) => r.json()).then((d) => {
      if (d.error) { setError(String(d.error)); setLoading(false); return; }
      setRoles(d.roles ?? []);
      setLabels(d.labels ?? {});
      setDraft(d.targets ?? {});
      setDefaults(d.defaults ?? {});
      setIsCustom(Boolean(d.isCustom));
      setStorageAvailable(d.storageAvailable !== false);
      setLoading(false);
    }).catch((e) => { setError(String(e)); setLoading(false); });
  }, [open]);

  // Same rules the server enforces — shown inline so a bad value never
  // requires a failed save to discover.
  const localErrors: string[] = [];
  for (const role of roles) {
    const b = draft[role];
    if (!b) continue;
    if (!Number.isFinite(b.min) || !Number.isFinite(b.max)) localErrors.push(`${role}: min and max must be numbers`);
    else if (b.min < 0 || b.max > 100) localErrors.push(`${role}: must be between 0 and 100`);
    else if (b.min > b.max) localErrors.push(`${role}: min (${b.min}%) is above max (${b.max}%)`);
  }
  const bands = roles.map((r) => draft[r]).filter((b): b is TargetBand => !!b);
  const minSum = bands.reduce((s, b) => s + (Number(b.min) || 0), 0);
  const maxSum = bands.reduce((s, b) => s + (Number(b.max) || 0), 0);
  const overlapWarnings: string[] = [];
  if (bands.length && minSum > 100) overlapWarnings.push(`Minimums total ${minSum}% — above 100%, so a role will always read below target.`);
  if (bands.length === roles.length && bands.length && maxSum < 100) overlapWarnings.push(`Maximums total ${maxSum}% — below 100%, so a role will always read above target.`);

  function setBand(role: string, key: "min" | "max", raw: string) {
    const v = raw === "" ? NaN : Number(raw);
    setDraft((d) => ({ ...d, [role]: { min: d[role]?.min ?? 0, max: d[role]?.max ?? 0, [key]: v } as TargetBand }));
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const resp = await fetch("/api/ppc/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: draft }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || d.ok === false) {
        setError(d.error ?? `Save failed (HTTP ${resp.status})`);
        return;
      }
      onOpenChange(false);
      onSaved({
        kind: "success",
        text: "Targets saved." + (d.warnings?.length ? ` ${d.warnings.join(" ")}` : ""),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  async function reset() {
    setSaving(true); setError(null);
    try {
      const resp = await fetch("/api/ppc/settings", { method: "DELETE" });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || d.ok === false) { setError(d.error ?? "Reset failed"); return; }
      onOpenChange(false);
      onSaved({ kind: "success", text: "Targets reset to the defaults in config/ads_strategy.json." });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Role spend-share targets</DialogTitle>
          <DialogDescription>
            The band each role&rsquo;s share of ad spend should sit in. Used for the
            above/below/on-target hints — nothing adjusts budgets automatically.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {isCustom
                ? "Custom — saved values are overriding the file defaults."
                : "Using defaults from config/ads_strategy.json."}
            </p>
            {!storageAvailable && (
              <p className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Settings table not found — run <code>supabase/migration_ads_strategy_settings.sql</code> to
                enable saving. Targets still read from the config file.
              </p>
            )}

            <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>Role</span><span className="text-right">Min %</span><span className="text-right">Max %</span>
            </div>
            {roles.map((role) => (
              <div key={role} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2">
                <div>
                  <span className="text-sm">{labels[role] ?? role}</span>
                  {defaults[role] && (
                    <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
                      default {defaults[role]!.min}–{defaults[role]!.max}%
                    </span>
                  )}
                </div>
                <Input type="number" min={0} max={100} step={1} className="h-8 text-right text-xs"
                  value={Number.isFinite(draft[role]?.min as number) ? String(draft[role]?.min) : ""}
                  onChange={(e) => setBand(role, "min", e.target.value)} />
                <Input type="number" min={0} max={100} step={1} className="h-8 text-right text-xs"
                  value={Number.isFinite(draft[role]?.max as number) ? String(draft[role]?.max) : ""}
                  onChange={(e) => setBand(role, "max", e.target.value)} />
              </div>
            ))}

            {localErrors.length > 0 && (
              <p role="alert" className="rounded-md border border-red-500/40 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
                {localErrors.join(" · ")}
              </p>
            )}
            {overlapWarnings.length > 0 && localErrors.length === 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {overlapWarnings.join(" ")}
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-red-500/40 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={reset} disabled={saving || loading || !isCustom}>
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving || loading || localErrors.length > 0 || !storageAvailable}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SYNC_JOB_LABELS: Record<string, string> = {
  ads_sync: "manual sync",
  ads_campaigns_sync: "campaigns",
  ads_search_terms_sync: "search terms",
  ads_campaigns_backfill: "90d backfill",
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800",
  P1: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800",
  P2: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-800",
};
// Row labels now come from the action vocabulary in @/lib/ppc-actions, which
// maps legacy `type` values too — see TYPE_TO_ACTION there.

/** Inline banner state — every generate outcome lands here, including failures. */
interface Notice { kind: "success" | "warn" | "error"; text: string }

const NOTICE_STYLES: Record<Notice["kind"], string> = {
  success: "border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn: "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-red-500/40 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200",
};

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div role={notice.kind === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs ${NOTICE_STYLES[notice.kind]}`}>
      {notice.kind === "success"
        ? <CheckCircle className="mt-px h-4 w-4 shrink-0" />
        : <AlertTriangle className="mt-px h-4 w-4 shrink-0" />}
      <span className="flex-1">{notice.text}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface ImpactByType {
  actionType: string; open: number; applied: number; dismissed: number;
  expired: number; total: number; impactEstimate: number;
}
interface ImpactHorizon {
  horizonDays: number;
  byStatus: Array<{ status: string; n: number; spend: number; adSales: number; orders: number; acos: number | null }>;
}
interface ImpactData {
  available: boolean; caveat: string; note?: string;
  totals: { decisions: number; outcomes: number; applied: number; dismissed: number;
            open: number; firstAsOf: string | null; lastAsOf: string | null } | null;
  byType: ImpactByType[];
  horizons: ImpactHorizon[];
}

/**
 * Decision-log summary. Deliberately plain: these are outcomes that FOLLOWED
 * actions, not effects attributable to them, and the panel says so rather than
 * dressing them up as a scorecard.
 */
function ImpactPanel() {
  const [data, setData] = useState<ImpactData | null>(null);
  useEffect(() => {
    fetch("/api/ppc/impact").then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) return null;
  if (!data.available) {
    return (
      <p className="text-xs text-muted-foreground">
        Action learning log not enabled — run <code>supabase/migration_ads_learning.sql</code>{" "}
        to start recording decisions and their outcomes.
      </p>
    );
  }
  const t = data.totals;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Action log
          {t && (
            <span className="ml-2 font-normal text-muted-foreground">
              {t.decisions} decisions{t.firstAsOf ? ` since ${t.firstAsOf}` : ""} ·{" "}
              {t.applied} applied · {t.dismissed} dismissed · {t.outcomes} outcome snapshots
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead className="text-right">Logged</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Applied</TableHead>
                <TableHead className="text-right">Dismissed</TableHead>
                <TableHead className="text-right">Impact est.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byType.map((b) => (
                <TableRow key={b.actionType}>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className={`text-[10px] ${ACTION_STYLES[b.actionType as keyof typeof ACTION_STYLES] ?? ""}`}>
                      {ACTION_LABELS[b.actionType as keyof typeof ACTION_LABELS] ?? b.actionType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.total}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{b.open}</TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-600">{b.applied}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{b.dismissed}</TableCell>
                  <TableCell className="text-right tabular-nums">${fmt(Math.round(b.impactEstimate))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {data.horizons.length > 0 && (
          <div className="space-y-1 text-xs">
            {data.horizons.map((h) => (
              <div key={h.horizonDays} className="flex flex-wrap items-center gap-x-5">
                <span className="font-medium">+{h.horizonDays}d after decision</span>
                {h.byStatus.map((s) => (
                  <span key={s.status} className="text-muted-foreground">
                    {s.status} (n={s.n}): spend{" "}
                    <span className="tabular-nums text-foreground">${fmtD(s.spend)}</span>, ad sales{" "}
                    <span className="tabular-nums text-foreground">${fmtD(s.adSales)}</span>
                    {s.acos != null && <>, ACOS <span className="tabular-nums text-foreground">{s.acos}%</span></>}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        {data.horizons.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No outcome snapshots yet — they are written once a decision&rsquo;s +7 day has closed.
          </p>
        )}

        <p className="rounded-lg border border-amber-500/40 bg-amber-50 p-2.5 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <strong>Observational, not causal.</strong> {data.caveat} Nothing here is applied
          automatically — every action still needs confirming in Seller Central.
        </p>
      </CardContent>
    </Card>
  );
}

type Range = "7d" | "14d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "14d", "30d", "90d"];
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "14d": 14, "30d": 30, "90d": 90 };

export default function PPCPage() {
  const [data, setData] = useState<PPCData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"actions" | "search" | "campaigns">("actions");
  // Which search term is expanded, and whether its drilldown shows campaigns
  // (default) or the per-day series. Daily rows are never the default view —
  // that is what made one term look like a dozen campaigns.
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const [byDay, setByDay] = useState(false);
  const [range, setRange] = useState<Range>("7d");
  const [generating, setGenerating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // null = "not overridden by the operator". The effective value is derived
  // below from the API's break-even so the input, the Generate button and the
  // exported plan all use the account's real break-even rather than a flat 30
  // that no longer matches what the engine applies (currently 36.9%).
  // Derived, not synced via an effect: an effect here would add a hook and a
  // render, and the value is a pure function of state we already have.
  const [targetAcosOverride, setTargetAcosOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  // Belongs to copyGrokPrompt() far below, but every hook lives in this block.
  // It previously sat next to its function, which put it AFTER the `loading`
  // early return: the loading render called N hooks and the loaded render
  // N+1, which is React error #310. Hooks first, derive second, return third —
  // no exceptions, however far the state is from the code that uses it.
  const [exporting, setExporting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/ppc");
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        // A platform error page or gateway timeout is HTML. Calling .json() on
        // it throws, and with no data set the page cannot distinguish that from
        // an empty account — so surface it as a load failure instead.
        setData({ fatalError: `Unexpected ${res.status} response from /api/ppc.` } as PPCData);
        setLoading(false);
        return;
      }
      setData(await res.json());
    } catch (e) {
      setData({
        fatalError: e instanceof Error ? e.message : "Could not reach /api/ppc.",
      } as PPCData);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isConfigured()) { setLoading(false); return; }
    loadData();
  }, [loadData]);

  async function updateRec(id: string, status: string) {
    await fetch("/api/ppc", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (data) {
      setData({
        ...data,
        recommendations: data.recommendations.map((r) =>
          r.id === id ? { ...r, status } : r
        ),
      });
    }
  }

  async function generateRecs() {
    setGenerating(true);
    setNotice(null);
    try {
      const resp = await fetch("/api/ppc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          target_acos: targetAcos,
          range_days: RANGE_DAYS[range],
        }),
      });

      // A non-2xx must never look like success — read the server's message.
      let result: { ok?: boolean; count?: number; message?: string; error?: string } = {};
      try { result = await resp.json(); } catch { /* non-JSON body */ }

      if (!resp.ok || result.ok === false) {
        setNotice({ kind: "error", text: result.error ?? `Generate failed (HTTP ${resp.status})` });
        return;
      }
      if (!result.count) {
        // Nothing to generate is an outcome, not a silent no-op.
        setNotice({ kind: "warn", text: result.message ?? "No search term data — run Ads sync first" });
        return;
      }

      await loadData();
      setTab("actions");
      setNotice({
        kind: "success",
        text: `Generated ${result.count} recommendation${result.count === 1 ? "" : "s"} from the last ${RANGE_DAYS[range]} days at ${targetAcos}% target ACOS.`,
      });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setGenerating(false);
    }
  }

  async function syncAds(days: number) {
    setSyncing(true);
    try {
      await fetch("/api/ppc/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      await loadData();
    } catch { /* */ }
    setSyncing(false);
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  // Operator override wins; otherwise the break-even the actions run recorded.
  const targetAcos = targetAcosOverride ?? data?.targetAcos ?? 30;
  const setTargetAcos = setTargetAcosOverride;

  const kpi = range === "7d" ? data?.kpi7 : range === "14d" ? data?.kpi14 : range === "30d" ? data?.kpi30 : data?.kpi90;
  const kpiDays = range === "7d" ? data?.kpi7Days : range === "14d" ? data?.kpi14Days : range === "30d" ? data?.kpi30Days : data?.kpi90Days;
  const rangeDays = RANGE_DAYS[range];
  const series = data?.dailySeries ?? [];
  // Chart shows exactly the window the KPI card sums, using the server's own
  // cutoff so the two can never disagree about where the window starts.
  // Same inclusive [cutoff .. asOf] bounds the KPI cards use, so the chart and
  // the cards can never cover different days. The server already trims the
  // series at as-of; the upper bound here keeps that true if it ever doesn't.
  const rangeCutoff = data?.cutoffs?.[range];
  const asOf = data?.asOf ?? null;
  const rangeSeries = series.filter(
    (d) => (!rangeCutoff || d.date >= rangeCutoff) && (!asOf || d.date <= asOf)
  );
  // Aggregated for the SELECTED range, so the table agrees with the KPI cards.
  const searchTerms = data?.searchTermsByRange?.[range] ?? data?.searchTerms ?? [];
  // Priority first, then dollars — same order the exported plan numbers them
  // in, so row 1 on screen is action 1 in the .md. P0 is "money burning now".
  const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const recs = (data?.recommendations ?? [])
    .filter((r) => r.status === "open")
    .sort((a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      b.impact_estimate - a.impact_estimate);
  const campaigns = data?.campaigns ?? [];
  // Both panels read the bucket for the selected range — no client-side date math.
  const roleBucket = data?.rolesByRange?.[range] ?? null;
  const adTypes = data?.adTypesByRange?.[range] ?? [];
  const spendScope = data?.spendScopeByRange?.[range] ?? null;
  const roles = roleBucket?.rows ?? [];
  const roleOther = roleBucket?.other ?? null;
  const recon = roleBucket?.reconciliation ?? null;
  const placements = data?.placementsByRange?.[range] ?? [];
  // Days actually carrying data inside the window, so a sparse short window
  // says so rather than implying a full one.
  const roleDays = roles.reduce((m, r) => Math.max(m, r.daysWithData), 0);
  const placementDays = placements.reduce((m, p) => Math.max(m, p.daysWithData), 0);
  const windowLabel = (dataDays: number) =>
    `${rangeDays} closed day${rangeDays === 1 ? "" : "s"} ending ${data?.asOf ?? "?"}` +
    (dataDays > 0 && dataDays < rangeDays ? ` · ${dataDays} with data` : "");
  const hasData = series.length > 0 || searchTerms.length > 0;

  // Rolled-up rows, so a term is counted once rather than once per day.
  const wastedTotal = searchTerms.filter((s) => s.orders === 0)
    .reduce((sum, s) => sum + Number(s.spend ?? 0), 0);

  // Format last sync
  const stamp = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const lastSyncLabel = data?.lastSync ? stamp(data.lastSync) : "never";
  const lastSyncJobLabel = data?.lastSyncJob
    ? SYNC_JOB_LABELS[data.lastSyncJob] ?? data.lastSyncJob
    : null;
  const lastActionsLabel = data?.lastActions ? stamp(data.lastActions) : null;

  /** Everything the exported plan needs — same numbers the KPI cards show. */
  function planContext() {
    return {
      range: range.toUpperCase(), rangeDays,
      // The window the plan covers, not the whole table — these must agree
      // with the KPI numbers directly below them.
      dateMin: rangeSeries[0]?.date ?? data?.dateMin ?? null,
      dateMax: rangeSeries[rangeSeries.length - 1]?.date ?? data?.dateMax ?? null,
      targetAcos, generatedOn: new Date().toISOString().slice(0, 10),
      kpi: kpi ? { spend: kpi.spend, adSales: kpi.adSales, acos: kpi.acos, tacos: kpi.tacos } : null,
      wastedSpend: wastedTotal,
    };
  }

  function exportPlan() {
    const ctx = planContext();
    const md = buildPlanMarkdown(recs as RecLike[], ctx);
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppc-action-plan-${ctx.generatedOn}-${range}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice({ kind: "success", text: `Downloaded ${a.download} — ${recs.length} actions.` });
  }

  /**
   * Copy the FULL account brief, not just the action list.
   *
   * The old export carried the recommendations, four KPIs and a target ACOS.
   * Everything else the system knows — placement economics, brand mix, the
   * organic-rank gate, multi-campaign term overlap, the break-even derivation,
   * and what has actually been learned so far — never reached the model, so it
   * reasoned about a fraction of the evidence.
   */
  /**
   * Download the brief as a file.
   *
   * Fetched rather than sent through a plain <a href>: a failure has to be
   * readable. The route answers 503 with JSON when it can neither build live
   * nor find a stored copy, and a bare link would have saved that JSON to disk
   * as a .md the operator only discovers is broken after opening it.
   */
  async function downloadBrief() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/ppc-export?days=${rangeDays}&download=1`);
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.includes("markdown")) {
        const d = ct.includes("json") ? await res.json() : null;
        setNotice({
          kind: "error",
          text: d?.hint ?? d?.error ?? `Could not build the brief (${res.status}).`,
        });
        return;
      }
      const source = res.headers.get("x-brief-source") ?? "live";
      const match = /filename="([^"]+)"/.exec(
        res.headers.get("content-disposition") ?? "");
      const name = match?.[1] ?? "ppc-command-brief.md";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice({
        kind: source === "published" ? "error" : "success",
        text: source === "published"
          ? `Downloaded ${name} — this is the STORED copy, not a live build. ` +
            `Rebuild with \`ppc-export --publish\` on the agent before acting on it.`
          : `Downloaded ${name} — live build.`,
      });
    } catch (e) {
      setNotice({
        kind: "error",
        text: `Download failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setDownloading(false);
    }
  }

  async function copyGrokPrompt() {
    setExporting(true);
    try {
      const r = await fetch(`/api/ppc-export?days=${rangeDays}`).then((x) => x.json());
      if (!r.available) {
        setNotice({ kind: "error", text: r.hint ?? r.error ?? "Could not build the brief." });
        return;
      }
      await navigator.clipboard.writeText(r.text);
      setNotice({
        // A cached brief must never be presented as current — the grade in it
        // is a graded WINDOW, and pasting a stale one into an AI would have it
        // advise on last week's account with this week's confidence.
        kind: r.source === "published" ? "error" : "success",
        text: r.source === "published"
          ? `Copied the STORED brief (${Math.round(r.chars / 1000)}k chars, grade ` +
            `${r.score ?? "—"}/100). ${r.staleness ?? ""} Rebuild it live with ` +
            `\`ppc-export --publish\` on the agent before acting on it.`
          : `Live brief copied (${Math.round(r.chars / 1000)}k chars) — graded window, ` +
            `economics, placement, brand mix, rank gate, term overlap, action plan, ` +
            `manager questions and known gaps. Paste into any AI.`,
      });
    } catch (e) {
      setNotice({ kind: "error", text: `Could not copy: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Amazon PPC</h1>
          <p className="text-sm text-muted-foreground">
            Phase 1: Read + Recommend
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Target ACOS
            <input type="number" min={1} max={200} step={1} value={targetAcos}
              onChange={(e) => setTargetAcos(Math.min(200, Math.max(1, Number(e.target.value) || 0)))}
              className="h-8 w-16 rounded-md border bg-transparent px-2 text-right text-xs tabular-nums text-foreground" />
            %
          </label>
          <Button variant="outline" size="sm" onClick={generateRecs} disabled={generating || !hasData}>
            {generating && <RefreshCw className="mr-1 h-3 w-3 animate-spin" />}
            {generating ? "Generating..." : `Generate Recs (${range.toUpperCase()})`}
          </Button>
          <Button variant="outline" size="sm" onClick={() => syncAds(14)} disabled={syncing}>
            <RefreshCw className={`mr-1 h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync 14D"}
          </Button>
        </div>
      </div>

      <SectionNav
        items={[
          { id: "ppc-kpis", label: "KPIs" },
          { id: "ppc-budget", label: "Budget" },
          { id: "ppc-placement", label: "Placement" },
          { id: "ppc-queue", label: "Actions" },
        ]}
      />

      {notice && <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />}

      {/* Saving refetches, so the strip, hints and quick-review row all pick up
          the new bands immediately for whichever range is selected. */}
      <TargetsDialog
        key={targetsOpen ? "targets-open" : "targets-closed"}
        open={targetsOpen}
        onOpenChange={setTargetsOpen}
        onSaved={(msg) => { setNotice(msg); loadData(); }}
      />

      {/* A failed load is NOT an empty account. Showing the sync prompt when a
          query errored sends the operator to re-run a sync that already worked,
          while the real fault stays invisible. */}
      {!hasData && (data?.fatalError || (data?.loadErrors?.length ?? 0) > 0) ? (
        <Card className="border-red-200 dark:border-red-900">
          <CardContent className="py-8 text-center">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              Could not load Ads data
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This is a load failure, not an empty account — do not re-run the
              sync until it is resolved.
            </p>
            <pre className="mt-3 whitespace-pre-wrap rounded bg-muted p-2 text-left text-[10px]">
              {data?.fatalError ?? ""}
              {(data?.loadErrors ?? []).join("\n")}
            </pre>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => { setLoading(true); loadData(); }}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !hasData ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Target className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No Ads data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run: <code>python -m src.main ads-sync --days 14</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Data freshness + range toggle */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              As of <span className="font-medium text-foreground">{asOf ?? "?"}</span> (America/Los_Angeles) ·{" "}
              Data: {data?.dateMin ?? "?"} → {data?.dateMax ?? "?"} · {data?.daysInDb ?? 0} days in DB · last sync {lastSyncLabel}
              {lastSyncJobLabel && ` (${lastSyncJobLabel}`}
              {lastSyncJobLabel && data?.lastSyncStatus && data.lastSyncStatus !== "success" && (
                <span className={data.lastSyncStatus === "fail" ? "text-red-500" : "text-amber-500"}>
                  {", "}{data.lastSyncStatus}
                </span>
              )}
              {lastSyncJobLabel && ")"}
              {lastActionsLabel && ` · actions rebuilt ${lastActionsLabel}`}
              {(kpiDays ?? 0) < rangeDays && (kpiDays ?? 0) > 0 && (
                <span className="ml-2 text-amber-500">
                  ({kpiDays}d of data in {range} window)
                </span>
              )}
            </p>
            <div className="flex gap-1 rounded-md border p-0.5">
              {RANGES.map((r) => (
                <button key={r} onClick={() => setRange(r)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${
                    range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                  }`}>
                  {r.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* KPI strip */}
          <div id="ppc-kpis" className="scroll-mt-14 grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Spend ({range})</p>
                <p className="text-2xl font-semibold tabular-nums">${fmtD(kpi?.spend ?? 0)}</p>
                {(kpi?.spend ?? 0) > 0 && (kpiDays ?? 0) > 0 && (
                  <p className="text-[10px] text-muted-foreground">${fmtD((kpi!.spend) / kpiDays!)}/day avg</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">Ad Sales ({range})</p>
                <p className="text-2xl font-semibold tabular-nums">${fmt(Math.round(kpi?.adSales ?? 0))}</p>
              </CardContent>
            </Card>
            <Card className={(kpi?.acos ?? 0) > 35 ? "border-red-500/30" : (kpi?.acos ?? 0) > 25 ? "border-amber-500/30" : "border-emerald-500/30"}>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.acos ?? 0).toFixed(1)}%</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">ROAS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.roas ?? 0).toFixed(1)}x</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[10px] text-muted-foreground uppercase">TACOS</p>
                <p className="text-2xl font-semibold tabular-nums">{(kpi?.tacos ?? 0).toFixed(1)}%</p>
                <p className="text-[10px] text-muted-foreground">ad spend / Amazon sales</p>
              </CardContent>
            </Card>
          </div>

          <PpcPlaybook />

          <BrandShare />

          <SqpStatus />

          {spendScope && spendScope.productsMissing.length > 0 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400">
              SPEND covers{" "}
              <span className="font-medium">
                {spendScope.productsPresent.join(" + ") || "no ad products"}
              </span>{" "}
              only — no {spendScope.productsMissing.join("/")} rows are stored for
              this window. Seller Central totals span Sponsored Products, Brands
              and Display, so the console will read higher. Run{" "}
              <code>ads-spend-audit --expect-spend &lt;console&gt;</code> to see
              the gap attributed.
            </p>
          )}
          {spendScope && Math.abs(spendScope.unallocated) >= 0.01 && (
            <p className="text-[10px] text-muted-foreground">
              Placement rows account for ${spendScope.placementSpend.toLocaleString(
                undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
              of ${spendScope.total.toLocaleString(
                undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })};{" "}
              <span className="font-medium">
                ${Math.abs(spendScope.unallocated).toLocaleString(
                  undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unallocated
              </span>{" "}
              (placement data is Sponsored Products only).
            </p>
          )}

          {/* Spend by ad product — the KPI cards above are SP+SB+SD combined,
              which is what the Amazon Ads console totals. This says which
              products those totals came from, so a mismatch is traceable to a
              product rather than a mystery. */}
          {adTypes.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                  <p className="text-xs font-medium">
                    Spend by ad product
                    <span className="ml-2 font-normal text-muted-foreground">
                      {windowLabel(roleDays)}
                    </span>
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    KPIs and TACoS above include all products
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {adTypes.map((t) => (
                    <div key={t.type} className="rounded-md border p-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[9px] ${AD_TYPE_STYLES[t.type] ?? ""}`}>
                          {t.type}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground truncate">{t.label}</span>
                      </div>
                      <p className="mt-1 text-lg font-semibold tabular-nums">${fmtD(t.spend)}</p>
                      <p className="text-[10px] text-muted-foreground tabular-nums">
                        {t.spendSharePct.toFixed(1)}% of spend · {fmt(t.clicks)} clicks
                        {t.cpc != null ? ` · $${t.cpc.toFixed(2)} CPC` : ""}
                      </p>
                      <p className="text-[10px] text-muted-foreground tabular-nums">
                        {t.campaigns} campaign{t.campaigns === 1 ? "" : "s"}
                        {t.acos != null ? ` · ${t.acos.toFixed(0)}% ACOS` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Budget share by role */}
          {roles.length > 0 && (
            <Card id="ppc-budget" className="scroll-mt-14">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm font-medium">
                    Budget by role
                    <span className="ml-2 font-normal text-muted-foreground">
                      {windowLabel(roleDays)}
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {data?.strategy?.isCustom ? "Custom targets" : "Using defaults"}
                    </Badge>
                    <Button variant="outline" size="sm" onClick={() => setTargetsOpen(true)}>
                      <Settings2 className="mr-1 h-3 w-3" />
                      Targets
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {/* One bar, segmented by share of spend */}
                <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full">
                  {roles.map((r) => (
                    <div key={r.role} className={ROLE_BARS[r.role] ?? "bg-muted"}
                      style={{ width: `${r.budgetSharePct}%` }}
                      title={`${r.label} ${r.budgetSharePct}%`} />
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {roles.map((r) => (
                    <div key={r.role} className="rounded-lg border p-3" title={r.description ?? undefined}>
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className={`text-[10px] ${ROLE_STYLES[r.role] ?? ""}`}>
                          {r.label}
                        </Badge>
                        <span className="text-sm font-semibold tabular-nums">{r.budgetSharePct}%</span>
                      </div>
                      <p className="mt-1.5 text-lg font-semibold tabular-nums">${fmt(Math.round(r.spend))}</p>
                      <p className="text-[10px] text-muted-foreground tabular-nums">
                        {r.campaigns} campaigns · ACOS {r.acos != null ? `${r.acos}%` : "—"} · TACoS {r.tacos != null ? `${r.tacos}%` : "—"}
                      </p>
                      {/* Target band and verdict both come from the server,
                          which reads config/ads_strategy.json → roles.targets. */}
                      {r.targetSharePct && (
                        <p className={`mt-1 text-[10px] tabular-nums ${
                          r.shareStatus === "in_range" ? "text-muted-foreground"
                            : r.shareStatus === "above" ? "text-amber-600 dark:text-amber-400"
                            : "text-blue-600 dark:text-blue-400"}`}>
                          target {r.targetSharePct.min}–{r.targetSharePct.max}%
                          {r.shareStatus === "above" && " · above target"}
                          {r.shareStatus === "below" && " · below target"}
                          {r.shareStatus === "in_range" && " · on target"}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {/* TACoS reconciliation: role slices are additive against the
                    same denominator as the account figure. */}
                {recon && (
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border bg-muted/30 p-2.5 text-[11px]"
                    title={"Role TACoS values are additive slices of total Amazon sales, not shares of TACoS. "
                      + "The spend % figures on the cards are shares of ad spend and sum to 100%."}>
                    <span className="text-muted-foreground">
                      Account TACoS{" "}
                      <span className="font-semibold tabular-nums text-foreground">
                        {recon.accountTacos != null ? `${recon.accountTacos}%` : "—"}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Sum of role TACoS{" "}
                      <span className="font-semibold tabular-nums text-foreground">
                        {recon.roleTacosSum != null ? `${recon.roleTacosSum}%` : "—"}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Other{" "}
                      <span className="font-semibold tabular-nums text-foreground">
                        {roleOther ? `${roleOther.tacos ?? 0}% ($${fmtD(roleOther.spend)})` : "0% ($0.00)"}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      = roles + Other{" "}
                      <span className="font-semibold tabular-nums text-foreground">
                        {recon.roleTacosSum != null
                          ? `${Math.round((recon.roleTacosSum + recon.otherTacos) * 100) / 100}%`
                          : "—"}
                      </span>
                    </span>
                  </div>
                )}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Roles are matched from campaign names in <code>config/ads_strategy.json</code>.
                  Discovery finds terms, Profit harvests them, Ranking buys position on hero ASINs,
                  Defense protects your own listings — each is judged against a different bar, so
                  a high-ACOS Ranking campaign is not automatically a problem.
                  Role TACoS is that role&rsquo;s spend over <em>total</em> Amazon sales, so the values
                  are additive slices of revenue and sum to account TACoS — they are not shares of
                  TACoS. The percentages on the cards are shares of ad spend and sum to 100%.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Quick review — one line, selected range only */}
          {roles.length > 0 && (() => {
            const pick = (role: string) => roles.find((r) => r.role === role) ?? null;
            const discovery = pick("discovery");
            const profit = pick("profit");
            const placeAcos = (name: string) =>
              placements.find((p) => p.placement === name)?.acos ?? null;
            const tos = placeAcos("Top of Search on-Amazon");
            const detail = placeAcos("Detail Page on-Amazon");
            const target = data?.targetAcos ?? null;
            const cmp = (v: number | null) =>
              v == null || target == null ? "" : v <= target ? " ✓" : " ✗";
            const tone = (v: number | null) =>
              v == null || target == null ? "text-foreground"
                : v <= target ? "text-emerald-600" : "text-amber-600 dark:text-amber-400";
            return (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border p-3 text-xs">
                <span className="font-medium">Quick review ({range.toUpperCase()})</span>
                <span className="text-muted-foreground">
                  Discovery share{" "}
                  <span className={`font-semibold tabular-nums ${
                    discovery?.shareStatus === "above" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                    {discovery ? `${discovery.budgetSharePct}%` : "—"}
                  </span>
                  {discovery?.targetSharePct && (
                    <span className="text-muted-foreground">
                      {" "}(target {discovery.targetSharePct.min}–{discovery.targetSharePct.max}%)
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">
                  Profit ACOS{" "}
                  <span className={`font-semibold tabular-nums ${tone(profit?.acos ?? null)}`}>
                    {profit?.acos != null ? `${profit.acos}%` : "—"}{cmp(profit?.acos ?? null)}
                  </span>
                  {target != null && (
                    <span className="text-muted-foreground"> vs {target}% break-even</span>
                  )}
                </span>
                <span className="text-muted-foreground">
                  TOS ACOS{" "}
                  <span className={`font-semibold tabular-nums ${tone(tos)}`}>
                    {tos != null ? `${tos}%` : "—"}{cmp(tos)}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Detail Page ACOS{" "}
                  <span className={`font-semibold tabular-nums ${tone(detail)}`}>
                    {detail != null ? `${detail}%` : "—"}{cmp(detail)}
                  </span>
                </span>
                {data?.targetAcosAsOf && (
                  <span className="text-[10px] text-muted-foreground">
                    break-even from the actions run on {data.targetAcosAsOf.slice(0, 10)}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Placement performance */}
          {data?.placementsAvailable && (
            <Card id="ppc-placement" className="scroll-mt-14">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Placement
                  <span className="ml-2 font-normal text-muted-foreground">
                    {windowLabel(placementDays)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                {placements.length === 0 ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">
                    No placement rows inside the {range.toUpperCase()} window.
                  </p>
                ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Placement</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">ACOS</TableHead>
                      <TableHead className="text-right">CVR</TableHead>
                      <TableHead className="text-right">CPC</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {placements.map((p) => (
                      <TableRow key={p.placement}>
                        <TableCell className="text-xs font-medium">{p.placement}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(p.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{p.sharePct}%</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(Math.round(p.sales))}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.acos != null ? `${p.acos}%` : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.cvr != null ? `${p.cvr}%` : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.cpc != null ? `$${fmtD(p.cpc)}` : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </CardContent>
            </Card>
          )}
          {data && !data.placementsAvailable && (
            <p className="text-xs text-muted-foreground">
              Placement breakdown not enabled — run <code>supabase/migration_ads_placement.sql</code>,
              then <code>python -m src.main ads-sync --days 14 --placements-only</code>.
            </p>
          )}

          {/* Trend chart */}
          {series.length > 0 && (
            <TrendsCard series={rangeSeries} range={range} rangeDays={rangeDays} />
          )}

          {/* Wasted spend alert */}
          {wastedTotal > 5 && (
            <Card className="border-red-500/30 cursor-pointer" onClick={() => setTab("actions")}>
              <CardContent className="p-4 flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
                <div>
                  <p className="font-semibold text-red-600">${fmtD(wastedTotal)} wasted</p>
                  <p className="text-xs text-muted-foreground">
                    {searchTerms.filter((s) => s.orders === 0 && s.spend >= 5).length} terms with $5+ spend, 0 orders
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Tab bar + plan export */}
          <div id="ppc-queue" className="scroll-mt-14 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {(["actions", "search", "campaigns"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                    tab === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}>
                  {t === "actions" ? `Actions (${recs.length})` : t === "search" ? "Search Terms" : "Campaigns"}
                </button>
              ))}
            </div>
            {tab === "actions" && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={exportPlan} disabled={!recs.length}>
                  <Download className="mr-1 h-3 w-3" />
                  Export plan (.md)
                </Button>
                <Button variant="outline" size="sm" onClick={copyGrokPrompt}
                        disabled={exporting}
                        title="Full account brief: economics, placement, brand mix, organic-rank gate, term overlap, every action with its reasoning, and the known gaps">
                  <ClipboardCopy className="mr-1 h-3 w-3" />
                  {exporting ? "Building brief…" : "Copy full AI brief"}
                </Button>
                <Button variant="outline" size="sm" onClick={downloadBrief}
                        disabled={downloading}
                        title="Download the same brief as a markdown file">
                  <Download className="mr-1 h-3 w-3" />
                  {downloading ? "Building…" : "Download brief"}
                </Button>
              </div>
            )}
          </div>

          {/* Actions queue */}
          {tab === "actions" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                {recs.length === 0 ? (
                  <div className="p-6 text-center">
                    <p className="text-sm font-medium">No open recommendations.</p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                      Run <strong>Generate Recommendations</strong> after an Ads sync has pulled search terms.
                      Without search-term rows there is nothing to negate, harvest or re-bid — sync first
                      (<code>python -m src.main ads-sync --days {rangeDays}</code>), then generate.
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={generateRecs} disabled={generating}>
                      {generating && <RefreshCw className="mr-1 h-3 w-3 animate-spin" />}
                      {generating ? "Generating..." : `Generate Recommendations (${range.toUpperCase()}, ${targetAcos}% ACOS)`}
                    </Button>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-14">Priority</TableHead>
                        <TableHead className="w-32">Action</TableHead>
                        <TableHead>Do this</TableHead>
                        <TableHead className="w-[160px]">Campaign</TableHead>
                        <TableHead className="w-24 text-right">Impact</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recs.map((r) => {
                        const at = actionTypeOf(r);
                        const open = expanded === r.id;
                        return (
                        <Fragment key={r.id}>
                        <TableRow className="cursor-pointer" onClick={() => setExpanded(open ? null : r.id)}>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] ${PRIORITY_COLORS[r.priority] ?? ""}`}>
                              {r.priority}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] whitespace-nowrap ${ACTION_STYLES[at]}`}>
                              {ACTION_LABELS[at]}
                            </Badge>
                            {/* Organic-rank gate. Only ever present on bid
                                increases — decreases and negatives carry no
                                rank fields, so rankBadgeOf returns null. */}
                            {(() => {
                              const rb = rankBadgeOf(r);
                              if (!rb) return null;
                              const tone =
                                rb.tone === "danger"
                                  ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900"
                                  : rb.tone === "warn"
                                  ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                                  : "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-700";
                              return (
                                <Badge
                                  variant="outline"
                                  className={`mt-1 block text-[9px] whitespace-normal ${tone}`}
                                  title={rb.title}
                                >
                                  {rb.label}
                                </Badge>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="text-xs">
                            {/* Fixed-width block: a table cell would otherwise
                                stretch to fit the sentence and push Campaign
                                and Impact off-screen. */}
                            <div className="flex w-[26rem] items-start gap-1.5 whitespace-normal xl:w-[34rem]">
                              <ChevronRight className={`mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                              <span className={open ? "" : "line-clamp-2"}>{doThisOf(r)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground truncate max-w-[160px]" title={r.campaign_name}>
                            {r.campaign_name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium text-red-600">${fmtD(r.impact_estimate)}</TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                                title="Mark applied" onClick={() => updateRec(r.id, "applied")}>
                                <CheckCircle className="h-3 w-3 text-emerald-500" />
                              </Button>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                                title="Dismiss" onClick={() => updateRec(r.id, "dismissed")}>
                                <X className="h-3 w-3 text-muted-foreground" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell />
                            <TableCell colSpan={5} className="py-3">
                              {/* whitespace-normal: TableCell sets nowrap, which
                                  would run these sentences off the card. */}
                              <dl className="grid max-w-4xl gap-x-6 gap-y-2 text-xs whitespace-normal sm:grid-cols-[7rem_1fr]">
                                <dt className="text-muted-foreground">Do this</dt>
                                <dd className="font-medium">{doThisOf(r)}</dd>
                                <dt className="text-muted-foreground">Why</dt>
                                <dd>{whyOf(r)}</dd>
                                <dt className="text-muted-foreground">
                                  {r.entity_type === "campaign" ? "Campaign" : r.entity_type === "keyword" ? "Keyword" : "Search term"}
                                </dt>
                                <dd className="break-all">{r.entity_name}</dd>
                                <dt className="text-muted-foreground">Campaign</dt>
                                <dd>
                                  {r.campaign_name || "—"}
                                  {adGroupsOf(r).length > 0 && (
                                    <span className="text-muted-foreground"> · ad group {adGroupsOf(r).join(", ")}</span>
                                  )}
                                </dd>
                                {matchTypesOf(r).length > 0 && (<>
                                  <dt className="text-muted-foreground">Match type</dt>
                                  <dd>{matchTypesOf(r).join(", ")}</dd>
                                </>)}
                                {suggestedBidOf(r) !== null && (<>
                                  <dt className="text-muted-foreground">Suggested bid</dt>
                                  <dd className="tabular-nums">${fmtD(suggestedBidOf(r) as number)}</dd>
                                </>)}
                                <dt className="text-muted-foreground">Impact estimate</dt>
                                <dd className="tabular-nums">${fmtD(r.impact_estimate)}</dd>
                              </dl>
                            </TableCell>
                          </TableRow>
                        )}
                        </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {tab === "actions" && <ImpactPanel />}

          {/* Search terms */}
          {tab === "search" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Search Term</TableHead>
                      <TableHead className="w-32">Campaigns</TableHead>
                      <TableHead className="w-28">Match</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">Orders</TableHead>
                      <TableHead className="text-right">ACOS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {searchTerms.slice(0, 50).map((s) => {
                      const open = openTerm === s.term_key;
                      const acos = s.sales > 0 ? (s.spend / s.sales) * 100 : 0;
                      const waste = s.orders === 0 && s.spend > 5;
                      return (
                        <Fragment key={s.term_key}>
                          <TableRow
                            className={`cursor-pointer ${waste ? "bg-red-50/50 dark:bg-red-950/20" : ""}`}
                            onClick={() => { setOpenTerm(open ? null : s.term_key); setByDay(false); }}
                          >
                            <TableCell className="text-xs font-medium max-w-[260px]">
                              <div className="flex items-start gap-1.5">
                                <ChevronRight className={`mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                                <span className="truncate">{s.search_term}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              {/* Multi-campaign overlap is the thing worth
                                  noticing: the same query bidding against
                                  itself in several campaigns. */}
                              {s.campaign_count > 1 ? (
                                <Badge variant="outline" className="text-[9px] whitespace-nowrap bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900">
                                  {s.campaign_count} campaigns
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground truncate block max-w-[8rem]">
                                  {s.campaigns[0]?.campaign_name ?? "—"}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {s.match_types.join(", ") || "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">${fmtD(s.spend)}</TableCell>
                            <TableCell className="text-right tabular-nums">${fmtD(s.sales)}</TableCell>
                            <TableCell className="text-right tabular-nums">{s.orders}</TableCell>
                            <TableCell className={`text-right tabular-nums ${acos > 35 ? "text-red-500" : acos > 25 ? "text-amber-500" : "text-emerald-500"}`}>
                              {acos > 0 ? `${acos.toFixed(0)}%` : "—"}
                            </TableCell>
                          </TableRow>

                          {open && (
                            <TableRow className="bg-muted/40 hover:bg-muted/40">
                              <TableCell colSpan={7} className="p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-xs font-medium">
                                    &ldquo;{s.search_term}&rdquo; — {s.campaign_count} campaign
                                    {s.campaign_count === 1 ? "" : "s"} over {windowLabel(kpiDays ?? 0)}
                                  </p>
                                  <Button variant="ghost" size="sm" className="text-xs"
                                          onClick={(e) => { e.stopPropagation(); setByDay(!byDay); }}>
                                    {byDay ? "Show by campaign" : "Show by report period"}
                                  </Button>
                                </div>

                                {!byDay ? (
                                  <table className="mt-2 w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-muted-foreground">
                                        <th className="py-1 pr-3">Campaign</th>
                                        <th className="py-1 pr-3">Ad groups</th>
                                        <th className="py-1 pr-3 text-right">Spend</th>
                                        <th className="py-1 pr-3 text-right">Sales</th>
                                        <th className="py-1 pr-3 text-right">Orders</th>
                                        <th className="py-1 pr-3 text-right">ACOS</th>
                                        <th className="py-1">Campaign ID</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {s.campaigns.map((c) => {
                                        const ca = c.sales > 0 ? (c.spend / c.sales) * 100 : 0;
                                        return (
                                          <tr key={c.campaign_id} className="border-t align-top">
                                            <td className="py-1 pr-3">{c.campaign_name || "—"}</td>
                                            <td className="py-1 pr-3 text-muted-foreground">
                                              {c.ad_groups.join(", ") || "—"}
                                            </td>
                                            <td className="py-1 pr-3 text-right tabular-nums">${fmtD(c.spend)}</td>
                                            <td className="py-1 pr-3 text-right tabular-nums">${fmtD(c.sales)}</td>
                                            <td className="py-1 pr-3 text-right tabular-nums">{c.orders}</td>
                                            <td className={`py-1 pr-3 text-right tabular-nums ${ca > 35 ? "text-red-500" : ""}`}>
                                              {ca > 0 ? `${ca.toFixed(0)}%` : "—"}
                                            </td>
                                            <td className="py-1">
                                              {/* Copy-friendly: Campaign Manager
                                                  search takes the name, and the
                                                  id disambiguates duplicates. */}
                                              <button
                                                type="button"
                                                className="font-mono text-[10px] text-blue-600 hover:underline dark:text-blue-400"
                                                title="Copy campaign name + ID for the Ads console"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  navigator.clipboard?.writeText(
                                                    `${c.campaign_name}\t${c.campaign_id}`);
                                                }}
                                              >
                                                {c.campaign_id || "—"} ⧉
                                              </button>
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                ) : (
                                  <>
                                  <p className="mt-2 text-[10px] text-muted-foreground">
                                    Search-term reports are pulled with
                                    <code className="mx-1">timeUnit=SUMMARY</code>
                                    per chunk, so each row is one reporting period
                                    stamped with its start date — Amazon does not
                                    publish true per-day search-term grain here.
                                  </p>
                                  <table className="mt-1 w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-muted-foreground">
                                        <th className="py-1 pr-3">Period start</th>
                                        <th className="py-1 pr-3 text-right">Spend</th>
                                        <th className="py-1 pr-3 text-right">Sales</th>
                                        <th className="py-1 pr-3 text-right">Orders</th>
                                        <th className="py-1 text-right">Clicks</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {s.days.map((d) => (
                                        <tr key={d.date} className="border-t">
                                          <td className="py-1 pr-3 tabular-nums">{d.date}</td>
                                          <td className="py-1 pr-3 text-right tabular-nums">${fmtD(d.spend)}</td>
                                          <td className="py-1 pr-3 text-right tabular-nums">${fmtD(d.sales)}</td>
                                          <td className="py-1 pr-3 text-right tabular-nums">{d.orders}</td>
                                          <td className="py-1 text-right tabular-nums">{d.clicks}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  </>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {tab === "actions" && <ImpactPanel />}

          {/* Campaigns */}
          {tab === "campaigns" && (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="w-14">Type</TableHead>
                      <TableHead className="w-24">Role</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">ACOS</TableHead>
                      <TableHead className="text-right">ROAS</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">CVR</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaigns.map((d) => (
                      <TableRow key={d.campaign_name}>
                        <TableCell className="text-xs font-medium truncate max-w-[250px]">{d.campaign_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] whitespace-nowrap ${AD_TYPE_STYLES[d.campaign_type] ?? ""}`}>
                            {d.campaign_type || "SP"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[9px] whitespace-nowrap ${ROLE_STYLES[d.role] ?? ""}`}>
                            {d.role}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(d.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmt(Math.round(d.sales))}</TableCell>
                        <TableCell className={`text-right tabular-nums ${d.acos > 35 ? "text-red-500" : ""}`}>{d.acos.toFixed(0)}%</TableCell>
                        <TableCell className="text-right tabular-nums">{d.roas.toFixed(1)}x</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(d.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.cvr.toFixed(1)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Disclaimer */}
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
            <span>
              Decision support only — user is responsible for all Ads Console changes.
              TACOS = ad spend / Amazon sales. ACOS uses 14-day attribution.
              Phase 1: no auto-bidding; recommendations must be manually applied in Seller Central.
            </span>
          </div>
        </>
      )}
    </div>
  );
}


/* ── Trends ──────────────────────────────────────────────────────
 * Line chart over the daily series the API already rolled up server-side.
 * One metric (or the two dollar series together) at a time on a single
 * y-axis; the tooltip carries every metric for the hovered day.
 * ---------------------------------------------------------------- */

type SeriesKey = "spend" | "ad_sales" | "acos" | "roas" | "tacos";
type Unit = "money" | "pct" | "x";

/** Colors are the validated categorical slots (light / dark steps). */
const SERIES_META: Record<SeriesKey, {
  label: string; unit: Unit; stroke: string; fill: string; swatch: string;
  value: (d: DailyPoint) => number | null;
}> = {
  spend: {
    label: "Spend", unit: "money",
    stroke: "stroke-[#2a78d6] dark:stroke-[#3987e5]",
    fill: "fill-[#2a78d6] dark:fill-[#3987e5]",
    swatch: "bg-[#2a78d6] dark:bg-[#3987e5]",
    value: (d) => d.spend,
  },
  ad_sales: {
    label: "Ad sales", unit: "money",
    stroke: "stroke-[#eb6834] dark:stroke-[#d95926]",
    fill: "fill-[#eb6834] dark:fill-[#d95926]",
    swatch: "bg-[#eb6834] dark:bg-[#d95926]",
    value: (d) => d.ad_sales,
  },
  acos: {
    label: "ACOS", unit: "pct",
    stroke: "stroke-[#4a3aa7] dark:stroke-[#9085e9]",
    fill: "fill-[#4a3aa7] dark:fill-[#9085e9]",
    swatch: "bg-[#4a3aa7] dark:bg-[#9085e9]",
    value: (d) => d.acos,
  },
  roas: {
    label: "ROAS", unit: "x",
    stroke: "stroke-[#12996a] dark:stroke-[#199e70]",
    fill: "fill-[#12996a] dark:fill-[#199e70]",
    swatch: "bg-[#12996a] dark:bg-[#199e70]",
    value: (d) => d.roas,
  },
  tacos: {
    label: "TACOS", unit: "pct",
    stroke: "stroke-[#c9558a] dark:stroke-[#d55181]",
    fill: "fill-[#c9558a] dark:fill-[#d55181]",
    swatch: "bg-[#c9558a] dark:bg-[#d55181]",
    value: (d) => d.tacos,
  },
};

type MetricKey = "both" | SeriesKey;

const METRICS: Array<{ key: MetricKey; label: string; series: SeriesKey[]; unit: Unit; note?: string }> = [
  { key: "both", label: "Spend + Sales", series: ["spend", "ad_sales"], unit: "money" },
  { key: "spend", label: "Spend", series: ["spend"], unit: "money" },
  { key: "ad_sales", label: "Ad sales", series: ["ad_sales"], unit: "money", note: "14-day attributed sales from ads" },
  { key: "acos", label: "ACOS", series: ["acos"], unit: "pct", note: "ad spend ÷ ad sales, per day" },
  { key: "roas", label: "ROAS", series: ["roas"], unit: "x", note: "ad sales ÷ ad spend, per day" },
  { key: "tacos", label: "TACOS", series: ["tacos"], unit: "pct", note: "ad spend ÷ Amazon sales that day — same definition as the KPI card" },
];

function fmtValue(v: number | null, unit: Unit): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (unit === "money") return `$${fmtD(v)}`;
  if (unit === "pct") return `${v.toFixed(1)}%`;
  return `${v.toFixed(2)}x`;
}

function fmtTick(v: number, unit: Unit): string {
  if (unit === "money") {
    if (v >= 1000) return `$${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
    // Sub-$10 axes need a decimal or every tick collapses to the same integer.
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: v > 0 && v < 10 ? 1 : 0 })}`;
  }
  if (unit === "pct") return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}x`;
}

/** Local-time parse of an ISO date — `new Date("2026-08-12")` is UTC and can slip a day. */
function parseISO(iso: string): Date { return new Date(`${iso}T00:00:00`); }
const DAY_MS = 86_400_000;

function fmtAxisDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtFullDate(iso: string): string {
  return parseISO(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Round a max up to a clean axis top (1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10 × 10^k). */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const pow = Math.pow(10, exp);
  const f = v / pow;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((s) => f <= s + 1e-9) ?? 10;
  return step * pow;
}

/** Container width, so the SVG renders at true pixel scale (no viewBox stretch). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function TrendsCard({ series, range, rangeDays }: { series: DailyPoint[]; range: Range; rangeDays: number }) {
  const [metric, setMetric] = useState<MetricKey>("both");
  const active = METRICS.find((m) => m.key === metric) ?? METRICS[0];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Daily trends — {active.label}
            <span className="ml-2 font-normal text-muted-foreground">
              {series.length} of {rangeDays} days
            </span>
          </CardTitle>
          <div className="flex flex-wrap gap-1 rounded-md border p-0.5">
            {METRICS.map((m) => (
              <button key={m.key} onClick={() => setMetric(m.key)}
                aria-pressed={metric === m.key}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  metric === m.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No ads data inside the {range.toUpperCase()} window.
          </p>
        ) : (
          <TrendChart series={series} metric={active} />
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          {active.note ? `${active.label} = ${active.note}. ` : ""}
          Only days present in <code>ads_campaigns_daily</code> are plotted — missing days break the line rather than filling with zero.
        </p>
      </CardContent>
    </Card>
  );
}

function TrendChart({
  series, metric,
}: {
  series: DailyPoint[];
  metric: { key: MetricKey; label: string; series: SeriesKey[]; unit: Unit };
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const H = 240;
  const padL = 52, padR = 60, padT = 14, padB = 24;
  const plotW = Math.max(width - padL - padR, 10);
  const plotH = H - padT - padB;

  // X is scaled by calendar date, not by index, so a missing day leaves a gap
  // instead of silently compressing time.
  const t0 = parseISO(series[0].date).getTime();
  const span = Math.max((parseISO(series[series.length - 1].date).getTime() - t0) / DAY_MS, 0);
  const xs = series.map((d) => {
    const off = (parseISO(d.date).getTime() - t0) / DAY_MS;
    return span === 0 ? padL + plotW / 2 : padL + (off / span) * plotW;
  });

  const values = metric.series.map((k) => series.map(SERIES_META[k].value));
  const maxVal = niceMax(Math.max(...values.flat().filter((v): v is number => v !== null), 0));
  const y = (v: number) => padT + plotH - (v / maxVal) * plotH;

  // 5 intervals: niceMax always divides by 5 into a clean step (50 → 10s,
  // 1000 → 200s, 2.5 → 0.5s), which quarters do not (50/4 = 12.5).
  const ticksY = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => maxVal * f);

  // ~8–12 x labels regardless of range (90 days → every 9th), always ending on
  // the last day; the second-to-last label is dropped if it would crowd it.
  const labelStep = Math.max(1, Math.ceil(series.length / 10));
  const last = series.length - 1;
  const xLabelIdx: number[] = [];
  for (let i = 0; i < last; i += labelStep) xLabelIdx.push(i);
  while (xLabelIdx.length && xs[last] - xs[xLabelIdx[xLabelIdx.length - 1]] < 28) xLabelIdx.pop();
  xLabelIdx.push(last);

  /** Split into contiguous runs: break on null values and on calendar gaps. */
  function segments(vals: Array<number | null>): Array<Array<{ x: number; y: number }>> {
    const out: Array<Array<{ x: number; y: number }>> = [];
    let cur: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      const gapBefore = i > 0 &&
        (parseISO(series[i].date).getTime() - parseISO(series[i - 1].date).getTime()) / DAY_MS > 1;
      if (v === null) { if (cur.length) out.push(cur); cur = []; continue; }
      if (gapBefore && cur.length) { out.push(cur); cur = []; }
      cur.push({ x: xs[i], y: y(v) });
    }
    if (cur.length) out.push(cur);
    return out;
  }

  const single = metric.series.length === 1;

  function pointerIndex(clientX: number, rect: DOMRect): number {
    const px = clientX - rect.left;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // End-of-line direct labels, dropped when the two series converge (stacking
  // them would detach the label from its line).
  const endPoints = metric.series.map((k) => {
    const vals = series.map(SERIES_META[k].value);
    for (let i = vals.length - 1; i >= 0; i--) {
      const v = vals[i];
      if (v !== null) return { key: k, x: xs[i], y: y(v), v };
    }
    return null;
  }).filter((p): p is NonNullable<typeof p> => p !== null);
  const labelsCollide = endPoints.length === 2 && Math.abs(endPoints[0].y - endPoints[1].y) < 14;

  return (
    <div ref={wrapRef} className="relative">
      {width > 0 && (
        <svg width={width} height={H} role="img"
          aria-label={`${metric.label} by day, ${series[0].date} to ${series[series.length - 1].date}`}>
          {/* Gridlines + y ticks */}
          {ticksY.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + plotW} y1={y(v)} y2={y(v)}
                style={{ stroke: "var(--border)" }} strokeWidth={1} />
              <text x={padL - 8} y={y(v)} dy="0.32em" textAnchor="end"
                className="fill-current text-muted-foreground text-[10px] tabular-nums">
                {fmtTick(v, metric.unit)}
              </text>
            </g>
          ))}

          {/* X tick labels */}
          {xLabelIdx.map((i) => (
            <text key={i} x={xs[i]} y={H - 6} textAnchor="middle"
              className="fill-current text-muted-foreground text-[10px] tabular-nums">
              {fmtAxisDate(series[i].date)}
            </text>
          ))}

          {/* Series */}
          {metric.series.map((k, si) => {
            const meta = SERIES_META[k];
            const segs = segments(values[si]);
            return (
              <g key={k}>
                {/* Area wash only for a single series — two overlapping washes muddy both */}
                {single && segs.map((seg, i) => (
                  <path key={`a${i}`}
                    d={`M${seg[0].x},${padT + plotH} ${seg.map((p) => `L${p.x},${p.y}`).join(" ")} L${seg[seg.length - 1].x},${padT + plotH} Z`}
                    className={meta.fill} fillOpacity={0.12} />
                ))}
                {segs.map((seg, i) => (
                  <path key={`l${i}`}
                    d={seg.map((p, j) => `${j === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")}
                    className={meta.stroke} fill="none" strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {/* A lone point has no line to draw — show the dot so it isn't invisible */}
                {segs.filter((s) => s.length === 1).map((seg, i) => (
                  <circle key={`p${i}`} cx={seg[0].x} cy={seg[0].y} r={3.5} className={meta.fill} />
                ))}
              </g>
            );
          })}

          {/* Direct end labels */}
          {!labelsCollide && endPoints.map((p) => (
            <g key={p.key}>
              <circle cx={p.x} cy={p.y} r={4} className={SERIES_META[p.key].fill}
                style={{ stroke: "var(--card)" }} strokeWidth={2} />
              <text x={p.x + 8} y={p.y} dy="0.32em"
                className="fill-current text-foreground text-[10px] font-medium tabular-nums">
                {fmtTick(p.v, metric.unit)}
              </text>
            </g>
          ))}

          {/* Crosshair */}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={xs[hover]} x2={xs[hover]} y1={padT} y2={padT + plotH}
                style={{ stroke: "var(--border)" }} strokeWidth={1} />
              {metric.series.map((k) => {
                const v = SERIES_META[k].value(series[hover]);
                if (v === null) return null;
                return (
                  <circle key={k} cx={xs[hover]} cy={y(v)} r={4}
                    className={SERIES_META[k].fill}
                    style={{ stroke: "var(--card)" }} strokeWidth={2} />
                );
              })}
            </g>
          )}

          {/* Hit layer — the pointer only has to be nearest, not on the line */}
          <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent"
            tabIndex={0} className="outline-none focus-visible:opacity-100"
            onPointerMove={(e) => setHover(pointerIndex(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(series.length - 1)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, (h ?? series.length - 1) - 1)); }
              if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => Math.min(series.length - 1, (h ?? 0) + 1)); }
            }} />
        </svg>
      )}

      {/* Legend — always present for two series */}
      {!single && (
        <div className="mt-1 flex items-center justify-center gap-4 text-[10px] text-muted-foreground">
          {metric.series.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={`inline-block h-0.5 w-3 rounded-full ${SERIES_META[k].swatch}`} />
              {SERIES_META[k].label}
            </span>
          ))}
        </div>
      )}

      {/* Tooltip — every metric for the hovered day, not just the plotted one */}
      {hover !== null && width > 0 && (
        <div className="pointer-events-none absolute z-10 w-48 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
          style={{
            left: Math.min(Math.max(xs[hover], padL), width),
            top: 4,
            transform: xs[hover] > width / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          }}>
          <p className="mb-1 text-[11px] font-medium">{fmtFullDate(series[hover].date)}</p>
          {(["spend", "ad_sales", "acos", "roas", "tacos"] as SeriesKey[]).map((k) => {
            const meta = SERIES_META[k];
            const on = metric.series.includes(k);
            return (
              <div key={k} className="flex items-center justify-between gap-2 text-[11px] leading-5">
                <span className={`flex items-center gap-1.5 ${on ? "text-foreground" : "text-muted-foreground"}`}>
                  <span className={`inline-block h-0.5 w-2.5 rounded-full ${meta.swatch} ${on ? "" : "opacity-40"}`} />
                  {meta.label}
                </span>
                <span className={`tabular-nums ${on ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                  {fmtValue(meta.value(series[hover]), meta.unit)}
                </span>
              </div>
            );
          })}
          <p className="mt-1 border-t pt-1 text-[10px] text-muted-foreground tabular-nums">
            Amazon sales ${fmtD(series[hover].amazon_sales)}
          </p>
        </div>
      )}
    </div>
  );
}
