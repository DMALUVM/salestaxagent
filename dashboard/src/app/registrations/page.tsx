"use client";

import { useEffect, useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { NexusStatus, StateRule, FilingEntry } from "@/lib/types";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSupabase } from "@/lib/supabase";
import {
  ClipboardCheck,
  Search,
  CheckCircle,
  XCircle,
  Pencil,
  Save,
  Info,
} from "lucide-react";

const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"] as const;
const FREQ_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-Annual",
  annual: "Annual",
};

interface RegistrationView {
  state_code: string;
  state_name: string;
  has_sales_tax: boolean;
  is_registered: boolean;
  registration_date: string | null;
  assigned_frequency: string | null;
  typical_due_day: number | null;
  last_filed_through: string | null;
  notes: string | null;
  filing_frequency_default: string | null;
  has_physical_nexus: boolean;
  has_economic_nexus: boolean;
}

interface EditState {
  is_registered: boolean;
  assigned_frequency: string;
  typical_due_day: string;
  last_filed_through: string;
  notes: string;
}

function buildRegistrationViews(
  rules: StateRule[],
  nexus: NexusStatus[],
  lastFiled: Record<string, string>,
): RegistrationView[] {
  const nexusMap = new Map(nexus.map((n) => [n.state_code, n]));
  return rules
    .filter((r) => r.has_sales_tax)
    .sort((a, b) => a.state_code.localeCompare(b.state_code))
    .map((r) => {
      const n = nexusMap.get(r.state_code);
      return {
        state_code: r.state_code,
        state_name: r.state_name,
        has_sales_tax: r.has_sales_tax,
        is_registered: n?.is_registered ?? false,
        registration_date: n?.registration_date ?? null,
        assigned_frequency: n?.assigned_frequency ?? null,
        typical_due_day: r.typical_due_day ?? null,
        last_filed_through: lastFiled[r.state_code] ?? null,
        notes: r.notes ?? null,
        filing_frequency_default: r.filing_frequency_default ?? null,
        has_physical_nexus: n?.has_physical_nexus ?? false,
        has_economic_nexus: n?.has_economic_nexus ?? false,
      };
    });
}

function EditDialog({
  reg,
  open,
  onOpenChange,
  onSaved,
}: {
  reg: RegistrationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditState>({
    is_registered: reg.is_registered,
    assigned_frequency: reg.assigned_frequency ?? reg.filing_frequency_default ?? "",
    typical_due_day: reg.typical_due_day?.toString() ?? "",
    last_filed_through: reg.last_filed_through ?? "",
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
      notes: reg.notes ?? "",
    });
    setError(null);
  }, [reg, open]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const sb = getSupabase();

    try {
      const dueDay = form.typical_due_day ? parseInt(form.typical_due_day) : null;
      if (dueDay !== null && (dueDay < 1 || dueDay > 31)) {
        setError("Due day must be between 1 and 31");
        setSaving(false);
        return;
      }

      // Update registration fields only — do NOT overwrite engine-computed
      // nexus or progress data.
      const { error: nexusErr } = await sb
        .from("nexus_status")
        .update({
          is_registered: form.is_registered,
          assigned_frequency: form.is_registered
            ? form.assigned_frequency || null
            : null,
          registration_date: form.is_registered
            ? reg.registration_date ?? new Date().toISOString().slice(0, 10)
            : null,
          last_filed_through: form.is_registered
            ? form.last_filed_through || null
            : null,
        })
        .eq("state_code", reg.state_code);

      if (nexusErr) {
        setError(nexusErr.message);
        setSaving(false);
        return;
      }

      // Update state_rules for due day and notes
      const { error: rulesErr } = await sb
        .from("state_rules")
        .update({
          typical_due_day: dueDay,
          notes: form.notes || null,
        })
        .eq("state_code", reg.state_code);

      if (rulesErr) {
        setError(rulesErr.message);
        setSaving(false);
        return;
      }

      // Generate filing calendar entries when a state is registered
      if (form.is_registered && form.assigned_frequency) {
        await fetch("/api/generate-filings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state_code: reg.state_code,
            frequency: form.assigned_frequency,
            due_day: dueDay ?? 20,
          }),
        }).catch(() => {});  // best-effort; don't block save
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
          <DialogTitle>
            {reg.state_name} ({reg.state_code})
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Registered for Sales Tax</label>
            <button
              type="button"
              role="switch"
              aria-checked={form.is_registered}
              onClick={() =>
                setForm((f) => ({ ...f, is_registered: !f.is_registered }))
              }
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                form.is_registered ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  form.is_registered ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          <div>
            <label className="text-sm font-medium">Filing Frequency</label>
            <Select
              value={form.assigned_frequency}
              onChange={(e) =>
                setForm((f) => ({ ...f, assigned_frequency: e.target.value }))
              }
              disabled={!form.is_registered}
              className="mt-1"
            >
              <option value="">
                {reg.filing_frequency_default
                  ? `Default (${FREQ_LABELS[reg.filing_frequency_default] ?? reg.filing_frequency_default})`
                  : "Select frequency..."}
              </option>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQ_LABELS[f] ?? f}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium">Last Filed Through</label>
            <Input
              type="date"
              value={form.last_filed_through}
              onChange={(e) =>
                setForm((f) => ({ ...f, last_filed_through: e.target.value }))
              }
              disabled={!form.is_registered}
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              End date of the last period you filed (e.g., 2025-06-30 for Q2).
              The Tax Liability page shows sales <strong>after</strong> this
              date.
            </p>
          </div>

          <div>
            <label className="text-sm font-medium">Typical Due Day</label>
            <Input
              type="number"
              min="1"
              max="31"
              placeholder="e.g., 20"
              value={form.typical_due_day}
              onChange={(e) =>
                setForm((f) => ({ ...f, typical_due_day: e.target.value }))
              }
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Day of the month the return is typically due
            </p>
          </div>

          <div>
            <label className="text-sm font-medium">Notes</label>
            <Textarea
              placeholder="Free-text notes (e.g., login info, CPA reminders)..."
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              rows={3}
              className="mt-1"
            />
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

function RegistrationTable({
  rows,
  onEdit,
}: {
  rows: RegistrationView[];
  onEdit: (reg: RegistrationView) => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck className="h-8 w-8" />}
        title="No states"
        description="No states match the current filter."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">State</TableHead>
            <TableHead className="w-40">Name</TableHead>
            <TableHead className="w-24">Registered</TableHead>
            <TableHead className="w-28">Frequency</TableHead>
            <TableHead className="w-20">Due Day</TableHead>
            <TableHead className="w-28">Last Filed</TableHead>
            <TableHead className="w-24">Nexus</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.state_code}
              className="group cursor-pointer hover:bg-muted/50"
              onClick={() => onEdit(r)}
            >
              <TableCell className="font-semibold">{r.state_code}</TableCell>
              <TableCell className="text-sm">{r.state_name}</TableCell>
              <TableCell>
                {r.is_registered ? (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      Yes
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <XCircle className="h-4 w-4 text-muted-foreground/40" />
                    <span className="text-xs text-muted-foreground">No</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                {r.is_registered && r.assigned_frequency ? (
                  <FrequencyBadge frequency={r.assigned_frequency} />
                ) : r.filing_frequency_default ? (
                  <span className="text-xs text-muted-foreground capitalize">
                    {r.filing_frequency_default} (default)
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {r.typical_due_day ? (
                  <span>
                    {r.typical_due_day}
                    <sup className="text-muted-foreground">
                      {r.typical_due_day === 1
                        ? "st"
                        : r.typical_due_day === 2
                        ? "nd"
                        : r.typical_due_day === 3
                        ? "rd"
                        : "th"}
                    </sup>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                {r.last_filed_through ? (
                  <span className="text-xs text-muted-foreground">
                    {r.last_filed_through}
                  </span>
                ) : r.is_registered ? (
                  <span className="text-xs text-muted-foreground/50">
                    Never
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">&mdash;</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {r.has_physical_nexus && (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800"
                    >
                      Physical
                    </Badge>
                  )}
                  {r.has_economic_nexus && (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800"
                    >
                      Economic
                    </Badge>
                  )}
                  {!r.has_physical_nexus && !r.has_economic_nexus && (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="max-w-[200px]">
                {r.notes ? (
                  <p className="truncate text-xs text-muted-foreground">{r.notes}</p>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(r);
                  }}
                >
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

export default function RegistrationsPage() {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<RegistrationView | null>(null);
  const {
    data: rules,
    loading: l1,
    refetch: refetchRules,
  } = useSupabaseQuery<StateRule>("state_rules", {
    orderBy: "state_code",
    ascending: true,
  });
  const {
    data: nexus,
    loading: l2,
    refetch: refetchNexus,
  } = useSupabaseQuery<NexusStatus>("nexus_status");
  const { data: filingEntries, loading: l3 } = useSupabaseQuery<FilingEntry>(
    "filing_calendar",
    { orderBy: "due_date", ascending: true },
  );

  // Derive last-filed-through from filing_calendar (fallback when
  // the user hasn't manually set it on the registration).
  const lastFiledMap = useMemo(() => {
    const m: Record<string, string> = {};
    // First: populate from nexus_status.last_filed_through (user-set)
    for (const n of nexus) {
      if (n.last_filed_through) m[n.state_code] = n.last_filed_through;
    }
    // Then: backfill from filing_calendar for states that don't have one
    for (const f of filingEntries) {
      if (f.status === "filed" && !m[f.state_code]) {
        m[f.state_code] = f.period_label;
      } else if (f.status === "filed" && m[f.state_code]) {
        // keep the latest
        if (f.due_date > (m[f.state_code] ?? "")) {
          // Only override if this looks like a later period
        }
      }
    }
    return m;
  }, [nexus, filingEntries]);

  if (l1 || l2 || l3) return <LoadingState />;

  const allRegs = buildRegistrationViews(rules, nexus, lastFiledMap);

  const filtered = allRegs.filter(
    (r) =>
      r.state_code.toLowerCase().includes(search.toLowerCase()) ||
      r.state_name.toLowerCase().includes(search.toLowerCase())
  );

  const registered = filtered.filter((r) => r.is_registered);
  const unregistered = filtered.filter((r) => !r.is_registered);
  const withNexus = filtered.filter(
    (r) =>
      !r.is_registered && (r.has_physical_nexus || r.has_economic_nexus)
  );

  function handleSaved() {
    refetchRules();
    refetchNexus();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Registrations</h1>
          <p className="text-sm text-muted-foreground">
            Manage sales tax registrations across all states
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter states..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-2xl font-semibold">{allRegs.filter((r) => r.is_registered).length}</p>
              <p className="text-xs text-muted-foreground">Registered</p>
            </div>
          </CardContent>
        </Card>
        <Card className={withNexus.length > 0 ? "border-amber-200 dark:border-amber-900" : ""}>
          <CardContent className="flex items-center gap-3 p-4">
            <Info className="h-5 w-5 text-amber-500" />
            <div>
              <p className="text-2xl font-semibold">
                {allRegs.filter((r) => !r.is_registered && (r.has_physical_nexus || r.has_economic_nexus)).length}
              </p>
              <p className="text-xs text-muted-foreground">Nexus, Not Registered</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <ClipboardCheck className="h-5 w-5 text-muted-foreground/50" />
            <div>
              <p className="text-2xl font-semibold">{allRegs.length}</p>
              <p className="text-xs text-muted-foreground">States with Sales Tax</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {withNexus.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-900">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <Info className="h-4 w-4" />
              Action Needed: Nexus detected but not registered
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {allRegs
                .filter((r) => !r.is_registered && (r.has_physical_nexus || r.has_economic_nexus))
                .map((r) => (
                  <Button
                    key={r.state_code}
                    variant="outline"
                    size="sm"
                    className="border-amber-200 dark:border-amber-800"
                    onClick={() => setEditing(r)}
                  >
                    {r.state_code} — {r.state_name}
                  </Button>
                ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Click a state to register. Consult your CPA before registering in a new state.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue={registered.length > 0 ? "registered" : "all"}>
        <TabsList>
          <TabsTrigger value="all">All ({filtered.length})</TabsTrigger>
          <TabsTrigger value="registered">
            Registered ({registered.length})
          </TabsTrigger>
          <TabsTrigger value="unregistered">
            Not Registered ({unregistered.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <RegistrationTable rows={filtered} onEdit={setEditing} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="registered" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <RegistrationTable rows={registered} onEdit={setEditing} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="unregistered" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <RegistrationTable rows={unregistered} onEdit={setEditing} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {editing && (
        <EditDialog
          reg={editing}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}

      <Disclaimer />
    </div>
  );
}
