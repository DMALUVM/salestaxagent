"use client";

import { useEffect, useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule, SalesByState, FranchiseTaxFlag } from "@/lib/types";
import { buildRecommendations, getTier, type StateRecommendation } from "@/lib/registration-model";
import { FrequencyBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Disclaimer } from "@/components/disclaimer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { getSupabase } from "@/lib/supabase";
import {
  ClipboardCheck, Search, CheckCircle, XCircle, Pencil, Save,
  AlertTriangle, Eye, ShieldAlert,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Tier mapping — deterministic from fba_inventory_creates_nexus value
// ---------------------------------------------------------------------------

// getTier imported from @/lib/registration-model

function tierBadge(tier: number) {
  if (tier === 1) return { label: "T1", cls: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800" };
  if (tier === 2) return { label: "T2", cls: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800" };
  if (tier === 3) return { label: "T3", cls: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700" };
  return null;
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function timeAgo(s: string) {
  const d = Date.now() - new Date(s).getTime();
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ---------------------------------------------------------------------------

const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"] as const;
const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly", quarterly: "Quarterly",
  semi_annual: "Semi-Annual", annual: "Annual",
};

interface RegRow {
  state_code: string;
  state_name: string;
  is_registered: boolean;
  registration_date: string | null;
  registration_number: string | null;
  registration_source: string | null;
  assigned_frequency: string | null;
  typical_due_day: number | null;
  last_filed_through: string | null;
  notes: string | null;
  filing_frequency_default: string | null;
  has_physical_nexus: boolean;
  has_economic_nexus: boolean;
  economic_pct: number;
  tier: number;
  fba_present: boolean;
  shopify_sales: number;
  has_franchise_flag: boolean;
  action: "register" | "monitor" | "registered" | "review";
  priority: number;
  updated_at: string | null;
  recommendation: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Edit Dialog (kept from original)
// ---------------------------------------------------------------------------

function EditDialog({
  reg, open, onOpenChange, onSaved,
}: {
  reg: RegRow; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    is_registered: reg.is_registered,
    assigned_frequency: reg.assigned_frequency ?? reg.filing_frequency_default ?? "",
    typical_due_day: reg.typical_due_day?.toString() ?? "",
    last_filed_through: reg.last_filed_through ?? "",
    registration_number: reg.registration_number ?? "",
    registration_date: reg.registration_date ?? "",
    registration_source: reg.registration_source ?? "",
    notes: reg.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      is_registered: reg.is_registered,
      assigned_frequency: reg.assigned_frequency ?? reg.filing_frequency_default ?? "",
      typical_due_day: reg.typical_due_day?.toString() ?? "",
      last_filed_through: reg.last_filed_through ?? "",
      registration_number: reg.registration_number ?? "",
      registration_date: reg.registration_date ?? "",
      registration_source: reg.registration_source ?? "",
      notes: reg.notes ?? "",
    });
    setError(null);
  }, [reg, open]);

  async function handleSave() {
    setSaving(true); setError(null);
    try {
      const dueDay = form.typical_due_day ? parseInt(form.typical_due_day) : null;
      if (dueDay !== null && (dueDay < 1 || dueDay > 31)) { setError("Due day 1-31"); setSaving(false); return; }

      // Save registration via server API route (service role, bypasses RLS)
      const regResp = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state_code: reg.state_code,
          is_registered: form.is_registered,
          registration_number: form.registration_number,
          registration_date: form.registration_date,
          registration_source: form.registration_source,
          assigned_frequency: form.is_registered ? form.assigned_frequency || null : null,
          last_filed_through: form.is_registered ? form.last_filed_through || null : null,
        }),
      });
      const regResult = await regResp.json();
      if (!regResp.ok) { setError(regResult.error ?? "Save failed"); setSaving(false); return; }

      // Save due day + notes to state_rules (client-side, these have permissive RLS)
      const sb = getSupabase();
      await sb.from("state_rules").update({ typical_due_day: dueDay, notes: form.notes || null }).eq("state_code", reg.state_code);

      // Generate filing calendar entries
      if (form.is_registered && form.assigned_frequency)
        await fetch("/api/generate-filings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state_code: reg.state_code, frequency: form.assigned_frequency, due_day: dueDay ?? 20 }) }).catch(() => {});

      setSaving(false); onOpenChange(false); onSaved();
    } catch (e) { setError(String(e)); setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{reg.state_name} ({reg.state_code})</DialogTitle></DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Registered</label>
            <button type="button" role="switch" aria-checked={form.is_registered} onClick={() => setForm(f => ({ ...f, is_registered: !f.is_registered }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${form.is_registered ? "bg-primary" : "bg-muted"}`}>
              <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${form.is_registered ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
          <div><label className="text-sm font-medium">Registration Number</label>
            <Input placeholder="e.g. 12-345678-001" value={form.registration_number} onChange={e => setForm(f => ({ ...f, registration_number: e.target.value }))} disabled={!form.is_registered} className="mt-1" />
            <p className="mt-0.5 text-xs text-muted-foreground">State sales tax permit / account ID</p></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-sm font-medium">Registration Date</label>
              <Input type="date" value={form.registration_date} onChange={e => setForm(f => ({ ...f, registration_date: e.target.value }))} disabled={!form.is_registered} className="mt-1" /></div>
            <div><label className="text-sm font-medium">Source</label>
              <Input placeholder="e.g. SST, state portal" value={form.registration_source} onChange={e => setForm(f => ({ ...f, registration_source: e.target.value }))} disabled={!form.is_registered} className="mt-1" /></div>
          </div>
          <div><label className="text-sm font-medium">Frequency</label>
            <Select value={form.assigned_frequency} onChange={e => setForm(f => ({ ...f, assigned_frequency: e.target.value }))} disabled={!form.is_registered} className="mt-1">
              <option value="">{reg.filing_frequency_default ? `Default (${FREQ_LABELS[reg.filing_frequency_default] ?? reg.filing_frequency_default})` : "Select..."}</option>
              {FREQUENCIES.map(f => <option key={f} value={f}>{FREQ_LABELS[f]}</option>)}
            </Select></div>
          <div><label className="text-sm font-medium">Last Filed Through</label>
            <Input type="date" value={form.last_filed_through} onChange={e => setForm(f => ({ ...f, last_filed_through: e.target.value }))} disabled={!form.is_registered} className="mt-1" /></div>
          <div><label className="text-sm font-medium">Due Day</label>
            <Input type="number" min="1" max="31" value={form.typical_due_day} onChange={e => setForm(f => ({ ...f, typical_due_day: e.target.value }))} className="mt-1" /></div>
          <div><label className="text-sm font-medium">Notes</label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} className="mt-1" /></div>
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div>}
        </div>
        <DialogFooter><Button onClick={handleSave} disabled={saving}><Save className="mr-1.5 h-3.5 w-3.5" />{saving ? "Saving..." : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RegistrationsPage() {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<RegRow | null>(null);
  const { data: rules, loading: l1, refetch: refetchRules } = useSupabaseQuery<StateRule>("state_rules", { orderBy: "state_code", ascending: true });
  const { data: nexus, loading: l2, refetch: refetchNexus } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: sales, loading: l3 } = useSupabaseQuery<SalesByState>("sales_by_state");
  const { data: flags } = useSupabaseQuery<FranchiseTaxFlag>("franchise_tax_flags", { filters: { status: "open" } });

  // Use the shared recommendation model
  const recs = useMemo(
    () => buildRecommendations(rules, nexus, sales, flags ?? []),
    [rules, nexus, sales, flags],
  );

  // Map to RegRow (add action field for tab filtering)
  const rows: RegRow[] = useMemo(() =>
    recs.map((r) => ({
      ...r,
      action: r.recommendation === "REGISTERED" ? "registered" as const
        : r.recommendation === "REGISTER_NOW" ? "register" as const
        : r.recommendation === "REVIEW" ? "review" as const
        : "monitor" as const,
    })),
    [recs],
  );

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => r.state_code.toLowerCase().includes(q) || r.state_name.toLowerCase().includes(q));
  }, [rows, search]);

  if (l1 || l2 || l3) return <LoadingState />;

  const registered = filtered.filter(r => r.action === "registered");
  const registerNow = filtered.filter(r => r.action === "register");
  const review = filtered.filter(r => r.action === "review");
  const monitor = filtered.filter(r => r.action === "monitor");

  function handleSaved() { refetchRules(); refetchNexus(); }

  function RegisteredTable({ rows, onEdit }: { rows: RegRow[]; onEdit: (r: RegRow) => void }) {
    if (rows.length === 0) return <EmptyState icon={<ClipboardCheck className="h-8 w-8" />} title="None" description="No registered states." />;
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">State</TableHead>
              <TableHead className="w-28">Name</TableHead>
              <TableHead className="w-32">Permit #</TableHead>
              <TableHead className="w-20">Tier</TableHead>
              <TableHead className="w-24">Frequency</TableHead>
              <TableHead className="w-24">Last Filed</TableHead>
              <TableHead className="w-24">Reg Date</TableHead>
              <TableHead className="text-right w-24">Shopify $</TableHead>
              <TableHead className="w-20">Updated</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => {
              const tb = tierBadge(r.tier);
              const updatedAgo = r.updated_at ? timeAgo(r.updated_at) : "—";
              return (
                <TableRow key={r.state_code} className="group cursor-pointer hover:bg-muted/50" onClick={() => onEdit(r)}>
                  <TableCell className="font-semibold">{r.state_code}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.state_name}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {r.registration_number || <span className="text-muted-foreground/30">—</span>}
                  </TableCell>
                  <TableCell>{tb && <Badge variant="outline" className={`text-[10px] ${tb.cls}`}>{tb.label}</Badge>}</TableCell>
                  <TableCell>
                    {r.assigned_frequency ? (
                      <FrequencyBadge frequency={r.assigned_frequency} />
                    ) : (
                      <span className="text-xs text-amber-500">not set</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.last_filed_through ? (
                      <span className="text-xs">{r.last_filed_through}</span>
                    ) : (
                      <span className="text-xs text-amber-500">never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.registration_date ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {r.shopify_sales > 0 ? `$${fmt(Math.round(r.shopify_sales))}` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{updatedAgo}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); onEdit(r); }}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  function ActionTable({ rows, label }: { rows: RegRow[]; label: string }) {
    if (rows.length === 0) return <EmptyState icon={<ClipboardCheck className="h-8 w-8" />} title="None" description={`No states in ${label}.`} />;
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">State</TableHead>
              <TableHead className="w-28">Tier</TableHead>
              <TableHead className="w-20">FBA</TableHead>
              <TableHead className="w-20">Reg</TableHead>
              <TableHead className="text-right w-24">Shopify $</TableHead>
              <TableHead className="text-right w-20">Econ %</TableHead>
              <TableHead className="w-24">Nexus</TableHead>
              <TableHead className="w-16">Flags</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => {
              const tb = tierBadge(r.tier);
              return (
                <TableRow key={r.state_code} className="group cursor-pointer hover:bg-muted/50" onClick={() => setEditing(r)}>
                  <TableCell className="font-semibold">{r.state_code}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {tb && <Badge variant="outline" className={`text-[10px] ${tb.cls}`}>{tb.label}</Badge>}
                      <span className="text-xs text-muted-foreground">{r.state_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.fba_present ? (
                      <span className="text-xs text-amber-600 dark:text-amber-400">Yes</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.is_registered ? (
                      <CheckCircle className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground/30" />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {r.shopify_sales > 0 ? `$${fmt(Math.round(r.shopify_sales))}` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {r.economic_pct > 0 ? (
                      <span className={r.economic_pct >= 100 ? "text-red-500 font-medium" : r.economic_pct >= 80 ? "text-amber-500" : ""}>
                        {Math.round(r.economic_pct)}%
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {r.has_physical_nexus && <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300">Phys</Badge>}
                      {r.has_economic_nexus && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300">Econ</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.has_franchise_flag && <ShieldAlert className="h-3.5 w-3.5 text-red-500" />}
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <span className="text-[10px] text-muted-foreground">{r.reason}</span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); setEditing(r); }}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Registrations</h1>
          <p className="text-sm text-muted-foreground">Tier-based registration priorities</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Filter states..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8" />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-emerald-500" />
            <div><p className="text-2xl font-semibold">{registered.length}</p><p className="text-xs text-muted-foreground">Registered</p></div>
          </CardContent>
        </Card>
        <Card className={registerNow.length > 0 ? "border-red-200 dark:border-red-900" : ""}>
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className={`h-5 w-5 ${registerNow.length > 0 ? "text-red-500" : "text-muted-foreground"}`} />
            <div><p className="text-2xl font-semibold">{registerNow.length}</p><p className="text-xs text-muted-foreground">Register Now</p></div>
          </CardContent>
        </Card>
        {review.length > 0 && (
          <Card className="border-amber-200 dark:border-amber-900">
            <CardContent className="flex items-center gap-3 p-4">
              <Eye className="h-5 w-5 text-amber-500" />
              <div><p className="text-2xl font-semibold">{review.length}</p><p className="text-xs text-muted-foreground">Review</p></div>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Eye className="h-5 w-5 text-blue-500" />
            <div><p className="text-2xl font-semibold">{monitor.length}</p><p className="text-xs text-muted-foreground">Monitor</p></div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue={registerNow.length > 0 ? "register" : registered.length > 0 ? "registered" : "monitor"}>
        <TabsList>
          <TabsTrigger value="registered">Registered ({registered.length})</TabsTrigger>
          <TabsTrigger value="register" className={registerNow.length > 0 ? "text-red-600 dark:text-red-400" : ""}>
            Register Now ({registerNow.length})
          </TabsTrigger>
          {review.length > 0 && (
            <TabsTrigger value="review">Review ({review.length})</TabsTrigger>
          )}
          <TabsTrigger value="monitor">Monitor ({monitor.length})</TabsTrigger>
        </TabsList>

        {/* Tier legend */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800">T1</Badge>
            Register if FBA + direct sales — not automatic for all T1 states
          </span>
          <span className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800">T2</Badge>
            FBA alone does not create nexus
          </span>
          <span className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700">T3</Badge>
            Unsettled
          </span>
        </div>

        <TabsContent value="registered" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Active Registrations</CardTitle>
              <p className="text-xs text-muted-foreground">
                Click any row to edit frequency, due day, or toggle registration off.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <RegisteredTable rows={registered} onEdit={setEditing} />
            </CardContent>
          </Card>

          {/* Audit: registered states that may need verification */}
          {registered.filter(r => !r.last_filed_through || !r.assigned_frequency).length > 0 && (
            <Card className="border-amber-200 dark:border-amber-900">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  Needs attention
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {registered.filter(r => !r.last_filed_through).map(r => (
                    <button key={r.state_code + "-lf"} onClick={() => setEditing(r)}
                      className="flex items-center gap-2 text-sm hover:underline">
                      <span className="font-medium">{r.state_code}</span>
                      <span className="text-muted-foreground">— no last-filed-through date set</span>
                    </button>
                  ))}
                  {registered.filter(r => !r.assigned_frequency).map(r => (
                    <button key={r.state_code + "-af"} onClick={() => setEditing(r)}
                      className="flex items-center gap-2 text-sm hover:underline">
                      <span className="font-medium">{r.state_code}</span>
                      <span className="text-muted-foreground">— no filing frequency assigned</span>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="register" className="mt-4">
          <Card className="border-red-200 dark:border-red-900">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
                <AlertTriangle className="h-4 w-4" />
                Register Now — direct-channel obligations
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Tier 1 states with FBA + Shopify direct sales, economic nexus crossed, or home/3PL state. Sorted by direct-sales volume.
              </p>
            </CardHeader>
            <CardContent className="p-0"><ActionTable rows={registerNow} label="Register Now" /></CardContent>
          </Card>
        </TabsContent>

        {review.length > 0 && (
          <TabsContent value="review" className="mt-4">
            <Card className="border-amber-200 dark:border-amber-900">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                  <Eye className="h-4 w-4" />
                  Review with CPA
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Contested positions (PA), high-risk (FL), or Tier 3 with material exposure. Confirm with SALT CPA before registering.
                </p>
              </CardHeader>
              <CardContent className="p-0"><ActionTable rows={review} label="Review" /></CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="monitor" className="mt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Eye className="h-4 w-4 text-blue-500" />
                Monitor — no registration required yet
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Tier 2 (FBA marketplace carve-out) and Tier 3 (uncertain) states below economic threshold. Amazon remits on FBA sales.
              </p>
            </CardHeader>
            <CardContent className="p-0"><ActionTable rows={monitor} label="Monitor" /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {editing && (
        <EditDialog reg={editing} open={!!editing} onOpenChange={o => { if (!o) setEditing(null); }} onSaved={handleSaved} />
      )}

      <Disclaimer />
    </div>
  );
}
