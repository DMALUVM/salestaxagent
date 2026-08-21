"use client";

import { useEffect, useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import { buildRecommendations, type StateRecommendation, type Recommendation } from "@/lib/registration-model";
import type { NexusStatus, StateRule, FilingEntry, FranchiseTaxFlag, SalesByState } from "@/lib/types";
import { LoadingState } from "@/components/loading";
import { Disclaimer } from "@/components/disclaimer";
import { FrequencyBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RegistrationPlan } from "@/components/registration-plan";
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
  Shield, Search, CheckCircle, AlertTriangle, Eye, Minus,
  Pencil, Save,
} from "lucide-react";

// ---------------------------------------------------------------------------

const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"] as const;
const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly", quarterly: "Quarterly",
  semi_annual: "Semi-Annual", annual: "Annual",
};

const REC_META: Record<Recommendation, { label: string; color: string; icon: typeof AlertTriangle }> = {
  REGISTER_NOW: { label: "Register Now", color: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800", icon: AlertTriangle },
  REVIEW: { label: "Review", color: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800", icon: Eye },
  MONITOR: { label: "Monitor", color: "text-muted-foreground bg-muted border-border", icon: Minus },
  REGISTERED: { label: "Registered", color: "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800", icon: CheckCircle },
};

// ---------------------------------------------------------------------------
// Edit Dialog (preserved from original registrations page)
// ---------------------------------------------------------------------------

interface EditState {
  is_registered: boolean;
  assigned_frequency: string;
  typical_due_day: string;
  last_filed_through: string;
  account_number: string;
  notes: string;
}

function EditDialog({
  rec, open, onOpenChange, onSaved,
}: {
  rec: StateRecommendation; open: boolean;
  onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<EditState>({
    is_registered: rec.is_registered,
    assigned_frequency: rec.assigned_frequency ?? rec.filing_frequency_default ?? "",
    typical_due_day: rec.typical_due_day?.toString() ?? "",
    last_filed_through: rec.last_filed_through ?? "",
    account_number: rec.registration_number ?? "",
    notes: rec.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      is_registered: rec.is_registered,
      assigned_frequency: rec.assigned_frequency ?? rec.filing_frequency_default ?? "",
      typical_due_day: rec.typical_due_day?.toString() ?? "",
      last_filed_through: rec.last_filed_through ?? "",
      account_number: rec.registration_number ?? "",
      notes: rec.notes ?? "",
    });
    setError(null);
  }, [rec, open]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const dueDay = form.typical_due_day ? parseInt(form.typical_due_day) : null;
      if (dueDay !== null && (dueDay < 1 || dueDay > 31)) {
        setError("Due day must be between 1 and 31");
        setSaving(false);
        return;
      }

      const regResp = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state_code: rec.state_code,
          is_registered: form.is_registered,
          assigned_frequency: form.is_registered ? form.assigned_frequency || null : null,
          registration_date: form.is_registered
            ? rec.registration_date ?? new Date().toISOString().slice(0, 10)
            : null,
          last_filed_through: form.is_registered ? form.last_filed_through || null : null,
          account_number: form.account_number || null,
        }),
      });
      const regResult = await regResp.json();
      if (!regResp.ok) { setError(regResult.error ?? "Save failed"); setSaving(false); return; }

      const sb = getSupabase();
      const { error: rulesErr } = await sb
        .from("state_rules")
        .update({ typical_due_day: dueDay, notes: form.notes || null })
        .eq("state_code", rec.state_code);
      if (rulesErr) { setError(rulesErr.message); setSaving(false); return; }

      if (form.is_registered && form.assigned_frequency) {
        const regDate = form.is_registered
          ? rec.registration_date ?? new Date().toISOString().slice(0, 10)
          : null;
        await fetch("/api/generate-filings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state_code: rec.state_code,
            frequency: form.assigned_frequency,
            due_day: dueDay ?? 20,
            registration_date: regDate,
          }),
        }).catch(() => {});
      }

      setSaving(false);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{rec.state_name} ({rec.state_code})</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Registered for Sales Tax</label>
            <button type="button" role="switch" aria-checked={form.is_registered}
              onClick={() => setForm((f) => ({ ...f, is_registered: !f.is_registered }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${form.is_registered ? "bg-primary" : "bg-muted"}`}>
              <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform ${form.is_registered ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
          <div>
            <label className="text-sm font-medium">Account Number</label>
            <Input
              placeholder="e.g., NC sales tax account ID"
              value={form.account_number}
              onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value }))}
              className="mt-1" />
            <p className="mt-1 text-xs text-muted-foreground">
              State tax account or registration number (no passwords)
            </p>
          </div>

          <div>
            <label className="text-sm font-medium">Filing Frequency</label>
            <Select value={form.assigned_frequency}
              onChange={(e) => setForm((f) => ({ ...f, assigned_frequency: e.target.value }))}
              disabled={!form.is_registered} className="mt-1">
              <option value="">{rec.filing_frequency_default ? `Default (${FREQ_LABELS[rec.filing_frequency_default] ?? rec.filing_frequency_default})` : "Select frequency..."}</option>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQ_LABELS[f]}</option>)}
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">Last Filed Through</label>
            <Input type="date" value={form.last_filed_through}
              onChange={(e) => setForm((f) => ({ ...f, last_filed_through: e.target.value }))}
              disabled={!form.is_registered} className="mt-1" />
            <p className="mt-1 text-xs text-muted-foreground">
              End date of the last period you filed. Liability page shows sales <strong>after</strong> this date.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium">Typical Due Day</label>
            <Input type="number" min="1" max="31" placeholder="e.g., 20"
              value={form.typical_due_day}
              onChange={(e) => setForm((f) => ({ ...f, typical_due_day: e.target.value }))}
              className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">Notes</label>
            <Textarea placeholder="Free-text notes..."
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3} className="mt-1" />
          </div>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function NexusRegistrationsPage() {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<StateRecommendation | null>(null);

  const { data: rules, loading: l1, refetch: refetchRules } = useSupabaseQuery<StateRule>("state_rules", { orderBy: "state_code", ascending: true });
  const { data: nexus, loading: l2, refetch: refetchNexus } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: salesByState, loading: l3 } = useSupabaseQuery<SalesByState>("sales_by_state");
  const { data: flags } = useSupabaseQuery<FranchiseTaxFlag>("franchise_tax_flags", { filters: { status: "open" } });

  const recs = useMemo(
    () => buildRecommendations(
      rules ?? [], nexus ?? [], salesByState ?? [],
      (flags ?? []) as unknown as Array<{ state_code: string; [key: string]: unknown }>,
    ),
    [rules, nexus, salesByState, flags],
  );

  if (l1 || l2 || l3) return <LoadingState />;

  const filtered = recs.filter(
    (r) => r.state_code.toLowerCase().includes(search.toLowerCase()) ||
           r.state_name.toLowerCase().includes(search.toLowerCase()),
  );

  const registerNow = filtered.filter((r) => r.recommendation === "REGISTER_NOW");
  const review = filtered.filter((r) => r.recommendation === "REVIEW");
  const registered = filtered.filter((r) => r.recommendation === "REGISTERED");
  const monitor = filtered.filter((r) => r.recommendation === "MONITOR");

  function handleSaved() { refetchRules(); refetchNexus(); }

  function RecBadge({ rec }: { rec: Recommendation }) {
    const m = REC_META[rec];
    const Icon = m.icon;
    return (
      <Badge variant="outline" className={`text-[10px] gap-1 ${m.color}`}>
        <Icon className="h-3 w-3" /> {m.label}
      </Badge>
    );
  }

  function StateTable({ rows }: { rows: StateRecommendation[] }) {
    if (!rows.length) return <p className="p-4 text-sm text-muted-foreground">No states in this category.</p>;
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">State</TableHead>
              <TableHead className="w-36">Name</TableHead>
              <TableHead className="w-28">Action</TableHead>
              <TableHead className="w-24">Nexus</TableHead>
              <TableHead className="w-20">Econ %</TableHead>
              <TableHead className="w-28">Frequency</TableHead>
              <TableHead className="w-24">Account #</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.state_code} className="group cursor-pointer hover:bg-muted/50"
                onClick={() => setEditing(r)}>
                <TableCell className="font-semibold">{r.state_code}</TableCell>
                <TableCell className="text-sm">{r.state_name}</TableCell>
                <TableCell><RecBadge rec={r.recommendation} /></TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {r.has_physical_nexus && (
                      <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800">
                        FBA
                      </Badge>
                    )}
                    {r.has_economic_nexus && (
                      <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800">
                        Econ
                      </Badge>
                    )}
                    {r.has_franchise_flag && (
                      <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800">
                        Entity
                      </Badge>
                    )}
                    {!r.has_physical_nexus && !r.has_economic_nexus && !r.has_franchise_flag && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums text-sm">
                  {r.economic_pct > 0 ? (
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full rounded-full ${r.economic_pct >= 100 ? "bg-red-500" : r.economic_pct >= 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${Math.min(r.economic_pct, 100)}%` }} />
                      </div>
                      <span className="text-xs">{r.economic_pct}%</span>
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {r.is_registered && r.assigned_frequency ? (
                    <FrequencyBadge frequency={r.assigned_frequency} />
                  ) : r.filing_frequency_default ? (
                    <span className="text-xs text-muted-foreground capitalize">{r.filing_frequency_default}</span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {r.registration_number ? (
                    <span className="text-xs tabular-nums">{r.registration_number}</span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <p className="text-xs text-muted-foreground truncate max-w-[250px]" title={r.reason}>{r.reason}</p>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-xs"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Nexus & Registrations</h1>
          <p className="text-sm text-muted-foreground">Where do I need to register? One answer per state.</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Filter states..." value={search}
            onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
      </div>

      {/* Ranked plan from the Python decision engine — the auditable version of
          the per-state cards below, with reasons and confidence on every row. */}
      <RegistrationPlan />

      {/* Summary strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <Card className={registerNow.length > 0 ? "border-red-200 dark:border-red-900" : ""}>
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className={`h-5 w-5 ${registerNow.length > 0 ? "text-red-500" : "text-muted-foreground/30"}`} />
            <div>
              <p className="text-2xl font-semibold">{recs.filter((r) => r.recommendation === "REGISTER_NOW").length}</p>
              <p className="text-xs text-muted-foreground">Register Now</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-2xl font-semibold">{recs.filter((r) => r.recommendation === "REGISTERED").length}</p>
              <p className="text-xs text-muted-foreground">Registered</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Eye className="h-5 w-5 text-amber-500" />
            <div>
              <p className="text-2xl font-semibold">{recs.filter((r) => r.recommendation === "REVIEW").length}</p>
              <p className="text-xs text-muted-foreground">Review with CPA</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Shield className="h-5 w-5 text-muted-foreground/50" />
            <div>
              <p className="text-2xl font-semibold">{recs.filter((r) => r.recommendation === "MONITOR").length}</p>
              <p className="text-xs text-muted-foreground">Monitor / No Action</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action needed callout */}
      {registerNow.length > 0 && (
        <Card className="border-red-200 dark:border-red-900">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              Register Now — nexus detected, not yet registered
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {recs.filter((r) => r.recommendation === "REGISTER_NOW").map((r) => (
                <Button key={r.state_code} variant="outline" size="sm"
                  className="border-red-200 dark:border-red-800"
                  onClick={() => setEditing(r)}>
                  {r.state_code} — {r.reason.slice(0, 40)}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Click a state to register. Consult your CPA before registering in a new state.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tabbed table */}
      <Tabs defaultValue={registerNow.length > 0 ? "register" : registered.length > 0 ? "registered" : "all"}>
        <TabsList>
          <TabsTrigger value="register" className={registerNow.length > 0 ? "text-red-600" : ""}>
            Register Now ({registerNow.length})
          </TabsTrigger>
          <TabsTrigger value="registered">Registered ({registered.length})</TabsTrigger>
          <TabsTrigger value="review">Review ({review.length})</TabsTrigger>
          <TabsTrigger value="monitor">Monitor ({monitor.length})</TabsTrigger>
          <TabsTrigger value="all">All ({filtered.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="mt-4">
          <Card><CardContent className="p-0"><StateTable rows={registerNow} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="registered" className="mt-4">
          <Card><CardContent className="p-0"><StateTable rows={registered} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="review" className="mt-4">
          <Card><CardContent className="p-0"><StateTable rows={review} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="monitor" className="mt-4">
          <Card><CardContent className="p-0"><StateTable rows={monitor} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="all" className="mt-4">
          <Card><CardContent className="p-0"><StateTable rows={filtered} /></CardContent></Card>
        </TabsContent>
      </Tabs>

      {editing && (
        <EditDialog rec={editing} open={!!editing}
          onOpenChange={(o) => { if (!o) setEditing(null); }}
          onSaved={handleSaved} />
      )}

      <Disclaimer />
    </div>
  );
}
