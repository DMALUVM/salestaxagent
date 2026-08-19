"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/loading";
import { isConfigured } from "@/lib/supabase";
import { Shield, Plus, Upload, Trash2, Save, DollarSign, Search } from "lucide-react";

interface CostRow {
  sku: string; product_name: string | null; cogs_per_unit: number;
  source: string; updated_at: string;
}

export default function CostsPage() {
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editName, setEditName] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSku, setAddSku] = useState("");
  const [addCost, setAddCost] = useState("");
  const [addName, setAddName] = useState("");
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const resp = await fetch("/api/costs");
      const data = await resp.json();
      setCosts(data.costs ?? []);
    } catch { /* ok */ }
    setLoading(false);
  }

  useEffect(() => { if (isConfigured()) load(); else setLoading(false); }, []);

  async function saveCost(sku: string, cogs: number, name?: string) {
    setSaving(true);
    await fetch("/api/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, cogs_per_unit: cogs, product_name: name }),
    });
    setEditing(null);
    await load();
    setSaving(false);
  }

  async function deleteCost(sku: string) {
    if (!confirm(`Delete COGS for ${sku}?`)) return;
    await fetch(`/api/costs?sku=${encodeURIComponent(sku)}`, { method: "DELETE" });
    await load();
  }

  async function addCostSubmit() {
    if (!addSku || !addCost) return;
    await saveCost(addSku.trim(), parseFloat(addCost), addName.trim() || undefined);
    setAddOpen(false); setAddSku(""); setAddCost(""); setAddName("");
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg(null);

    try {
      const text = await file.text();
      const rows: Array<{ sku: string; cogs_per_unit: number; product_name?: string }> = [];

      if (file.name.endsWith(".csv")) {
        const lines = text.split("\n");
        const headers = lines[0].toLowerCase().split(",").map((h) => h.trim());
        const skuIdx = headers.findIndex((h) => h.includes("sku"));
        const costIdx = headers.findIndex((h) => h.includes("cost") || h.includes("cogs"));
        const nameIdx = headers.findIndex((h) => h.includes("name") || h.includes("product"));

        for (const line of lines.slice(1)) {
          const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
          const sku = cols[skuIdx] ?? "";
          const cost = parseFloat(cols[costIdx] ?? "0");
          if (sku && !isNaN(cost)) {
            rows.push({ sku, cogs_per_unit: cost, product_name: cols[nameIdx] || undefined });
          }
        }
      } else {
        setUploadMsg("For .xlsx files, use CLI: python -m src.main costs-import path/to/file.xlsx");
        e.target.value = "";
        return;
      }

      if (!rows.length) { setUploadMsg("No valid rows found"); e.target.value = ""; return; }

      const resp = await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const result = await resp.json();
      if (result.ok) {
        setUploadMsg(`Imported ${result.count} SKU costs from ${file.name}`);
        await load();
      } else {
        setUploadMsg(result.error || "Upload failed");
      }
    } catch (err) {
      setUploadMsg(`Error: ${err}`);
    }
    e.target.value = "";
  }

  if (!isConfigured()) return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
    </div>
  );
  if (loading) return <LoadingState />;

  const filtered = costs.filter((c) =>
    c.sku.toLowerCase().includes(search.toLowerCase()) ||
    (c.product_name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const totalCosts = costs.length;
  const avgCogs = totalCosts > 0 ? costs.reduce((s, c) => s + Number(c.cogs_per_unit), 0) / totalCosts : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">COGS Management</h1>
          <p className="text-sm text-muted-foreground">Unit costs per SKU for contribution P&L</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add SKU
          </Button>
          <label className="cursor-pointer">
            <span className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors">
              <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload CSV
            </span>
            <input type="file" accept=".csv,.xlsx" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </div>

      {uploadMsg && (
        <div className="rounded-lg border p-3 text-sm text-muted-foreground">{uploadMsg}</div>
      )}

      {/* Summary */}
      <div className="grid gap-3 grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">SKUs with Cost</p>
            <p className="text-2xl font-semibold tabular-nums">{totalCosts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Avg COGS/Unit</p>
            <p className="text-2xl font-semibold tabular-nums">${avgCogs.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] text-muted-foreground uppercase">Last Updated</p>
            <p className="text-lg font-semibold">
              {costs[0]?.updated_at ? new Date(costs[0].updated_at).toLocaleDateString() : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative w-full sm:w-64">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Filter SKUs..." value={search}
          onChange={(e) => setSearch(e.target.value)} className="pl-8" />
      </div>

      {/* Table */}
      {!costs.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <DollarSign className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No COGS data yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Upload a CSV, add SKUs manually, or run: <code>python -m src.main costs-import incoming/COGS/COGS-1-18-26.xlsx</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">COGS $/unit</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow key={c.sku} className="group">
                    <TableCell className="font-medium text-xs">{c.sku}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {editing === c.sku ? (
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-xs" placeholder="Product name" />
                      ) : (
                        c.product_name || "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {editing === c.sku ? (
                        <div className="flex gap-1 justify-end">
                          <Input type="number" step="0.01" min="0" value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="h-7 w-24 text-xs text-right" />
                          <Button size="sm" className="h-7" disabled={saving}
                            onClick={() => saveCost(c.sku, parseFloat(editValue), editName)}>
                            <Save className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="cursor-pointer hover:text-primary"
                          onClick={() => { setEditing(c.sku); setEditValue(String(c.cogs_per_unit)); setEditName(c.product_name ?? ""); }}>
                          ${Number(c.cogs_per_unit).toFixed(2)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[9px]">{c.source}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                        onClick={() => deleteCost(c.sku)}>
                        <Trash2 className="h-3 w-3 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add SKU Cost</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="SKU (e.g. DDPE0004Shop)" value={addSku} onChange={(e) => setAddSku(e.target.value)} />
            <Input placeholder="Product name (optional)" value={addName} onChange={(e) => setAddName(e.target.value)} />
            <Input type="number" step="0.01" min="0" placeholder="COGS per unit ($)" value={addCost} onChange={(e) => setAddCost(e.target.value)} />
          </div>
          <DialogFooter>
            <Button onClick={addCostSubmit} disabled={!addSku || !addCost}>
              <Save className="mr-1.5 h-3.5 w-3.5" /> Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
        <span>
          COGS are seller-provided unit costs. Amazon Finances API does not supply COGS.
          Next pnl-sync will use these costs for Contribution = Payout - COGS - Ads.
          For xlsx import, use CLI: <code>python -m src.main costs-import path/to/file.xlsx</code>
        </span>
      </div>
    </div>
  );
}
