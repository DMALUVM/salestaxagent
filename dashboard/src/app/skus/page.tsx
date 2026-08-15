"use client";

import { useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { SalesBySku } from "@/lib/types";
import { normalizeChannel } from "@/lib/channels";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Package, Search, ShoppingBag } from "lucide-react";

// ---------------------------------------------------------------------------

type YearFilter = "all" | "2024" | "2025" | "2026";
type ChFilter = "all" | "shopify" | "amazon";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface SkuAgg {
  sku: string;
  asin: string | null;
  title: string | null;
  channel: string;
  units: number;
  grossSales: number;
  refundUnits: number;
  refundSales: number;
  net: number;
  stateCount: number;
  states: Set<string>;
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function SkusPage() {
  const [year, setYear] = useState<YearFilter>("2026");
  const [ch, setCh] = useState<ChFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const { data: skuData, loading } = useSupabaseQuery<SalesBySku>("sales_by_sku");

  const aggs = useMemo(() => {
    const m: Record<string, SkuAgg> = {};

    for (const s of skuData) {
      if (year !== "all" && !s.period_start?.startsWith(year)) continue;
      const c = normalizeChannel(s.channel);
      if (ch !== "all" && c !== ch) continue;

      const key = `${c}:${s.sku}`;
      if (!m[key]) {
        m[key] = {
          sku: s.sku,
          asin: s.asin,
          title: s.product_title,
          channel: c,
          units: 0,
          grossSales: 0,
          refundUnits: 0,
          refundSales: 0,
          net: 0,
          stateCount: 0,
          states: new Set(),
        };
      }
      const a = m[key];
      a.units += s.units;
      a.grossSales += s.gross_sales;
      a.refundUnits += s.refund_units;
      a.refundSales += s.refund_sales;
      a.net += s.gross_sales - s.refund_sales;
      if (s.state_code && s.state_code !== "XX") a.states.add(s.state_code);
      if (!a.title && s.product_title) a.title = s.product_title;
      if (!a.asin && s.asin) a.asin = s.asin;
    }

    // Finalize state counts
    for (const a of Object.values(m)) a.stateCount = a.states.size;
    return Object.values(m).sort((a, b) => b.grossSales - a.grossSales);
  }, [skuData, year, ch]);

  const filtered = search
    ? aggs.filter(
        (a) =>
          a.sku.toLowerCase().includes(search.toLowerCase()) ||
          (a.title ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (a.asin ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : aggs;

  // Detail: sales by state for selected SKU
  const detail = useMemo(() => {
    if (!selected) return [];
    const rows: { state: string; gross: number; units: number }[] = [];
    const m: Record<string, { gross: number; units: number }> = {};
    for (const s of skuData) {
      if (year !== "all" && !s.period_start?.startsWith(year)) continue;
      const key = `${normalizeChannel(s.channel)}:${s.sku}`;
      if (key !== selected) continue;
      const sc = s.state_code || "XX";
      if (!m[sc]) m[sc] = { gross: 0, units: 0 };
      m[sc].gross += s.gross_sales;
      m[sc].units += s.units;
    }
    for (const [state, d] of Object.entries(m)) {
      rows.push({ state, ...d });
    }
    return rows.sort((a, b) => b.gross - a.gross);
  }, [skuData, selected, year]);

  const selectedAgg = selected ? aggs.find((a) => `${a.channel}:${a.sku}` === selected) : null;

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">SKU Performance</h1>
          <p className="text-sm text-muted-foreground">
            Product-level sales, units, and refunds
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            options={[
              { value: "all" as ChFilter, label: "All" },
              { value: "amazon" as ChFilter, label: "Amazon" },
              { value: "shopify" as ChFilter, label: "Shopify" },
            ]}
            value={ch}
            onChange={setCh}
          />
          <ToggleGroup
            options={[
              { value: "all" as YearFilter, label: "All" },
              { value: "2024" as YearFilter, label: "2024" },
              { value: "2025" as YearFilter, label: "2025" },
              { value: "2026" as YearFilter, label: "2026" },
            ]}
            value={year}
            onChange={setYear}
          />
        </div>
      </div>

      {/* Search */}
      <div className="relative w-full sm:w-72">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search SKU, title, ASIN..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title="No SKU data"
          description={
            skuData.length === 0
              ? "Run the SKU backfill to populate product-level data: python -m src.main backfill-shopify-skus"
              : "No SKUs match the current filters."
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead className="hidden sm:table-cell">Title</TableHead>
                    <TableHead className="w-20">Channel</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Gross $</TableHead>
                    <TableHead className="text-right">Refunds $</TableHead>
                    <TableHead className="text-right">Net $</TableHead>
                    <TableHead className="text-right w-16">States</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 100).map((a) => {
                    const key = `${a.channel}:${a.sku}`;
                    return (
                      <TableRow
                        key={key}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setSelected(key)}
                      >
                        <TableCell className="font-mono text-xs">
                          {a.sku}
                          {a.asin && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {a.asin}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="hidden max-w-[200px] truncate text-sm sm:table-cell">
                          {a.title ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {a.channel === "shopify" ? "Shop" : "AMZ"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(a.units)}</TableCell>
                        <TableCell className="text-right tabular-nums">${fmtD(a.grossSales)}</TableCell>
                        <TableCell className="text-right tabular-nums text-red-500">
                          {a.refundSales > 0 ? `-$${fmtD(a.refundSales)}` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          ${fmtD(a.net)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{a.stateCount}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detail drawer */}
      {selected && selectedAgg && (
        <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
          <SheetContent side="right" className="w-80 sm:w-96 overflow-y-auto">
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{selectedAgg.sku}</SheetTitle>
            </SheetHeader>
            <div className="mt-3 space-y-4">
              {selectedAgg.title && (
                <p className="text-sm text-muted-foreground">{selectedAgg.title}</p>
              )}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Units</span>
                <span className="text-right tabular-nums">{fmt(selectedAgg.units)}</span>
                <span className="text-muted-foreground">Gross</span>
                <span className="text-right tabular-nums">${fmtD(selectedAgg.grossSales)}</span>
                <span className="text-muted-foreground">Refunds</span>
                <span className="text-right tabular-nums text-red-500">
                  ${fmtD(selectedAgg.refundSales)} ({selectedAgg.refundUnits} units)
                </span>
                <span className="text-muted-foreground">Net</span>
                <span className="text-right tabular-nums font-medium">${fmtD(selectedAgg.net)}</span>
                <span className="text-muted-foreground">States</span>
                <span className="text-right">{selectedAgg.stateCount}</span>
              </div>

              {detail.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Sales by State
                  </h4>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {detail.map((d) => (
                      <div key={d.state} className="flex justify-between text-sm">
                        <span className="font-medium">{d.state}</span>
                        <span className="tabular-nums text-muted-foreground">
                          ${fmtD(d.gross)} ({fmt(d.units)} u)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
