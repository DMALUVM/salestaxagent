"use client";

import { useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { SalesBySku } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { displayTitle, rawTitle } from "@/lib/display-title";
import { LoadingState } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Package, Search, ArrowUpDown, Info } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChFilter = "all" | "shopify" | "amazon";
type TimeGrain = "monthly" | "quarterly" | "yearly";
type SortKey = "sku" | "units" | "gross" | "refunds" | "net" | "orders";

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface SkuAgg {
  sku: string;
  asin: string | null;
  title: string | null;
  units: number;
  grossSales: number;
  refundUnits: number;
  refundSales: number;
  hasRefundData: boolean;
  net: number;
  orders: number;
  stateCount: number;
  states: Set<string>;
  channels: Set<string>;
  shopifyGross: number;
  amazonGross: number;
}

// Derive available months from data
function availableMonths(data: SalesBySku[]): string[] {
  const s = new Set<string>();
  for (const d of data) {
    if (d.period_start) s.add(d.period_start.slice(0, 7));
  }
  return Array.from(s).sort();
}

function monthInRange(ps: string, from: string | null, to: string | null) {
  const m = ps.slice(0, 7);
  if (from && m < from) return false;
  if (to && m > to) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation: merges channels into one row per SKU
// ---------------------------------------------------------------------------

function aggregate(
  data: SalesBySku[],
  ch: ChFilter,
  from: string | null,
  to: string | null,
): SkuAgg[] {
  const m: Record<string, SkuAgg> = {};

  for (const s of data) {
    const c = normalizeChannel(s.channel);
    if (ch !== "all" && c !== ch) continue;
    if (!monthInRange(s.period_start ?? "", from, to)) continue;

    const key = s.sku; // normalized (uppercased) at ingest
    if (!m[key]) {
      m[key] = {
        sku: s.sku,
        asin: null,
        title: null,
        units: 0,
        grossSales: 0,
        refundUnits: 0,
        refundSales: 0,
        hasRefundData: false,
        net: 0,
        orders: 0,
        stateCount: 0,
        states: new Set(),
        channels: new Set(),
        shopifyGross: 0,
        amazonGross: 0,
      };
    }
    const a = m[key];
    a.units += s.units;
    a.grossSales += s.gross_sales;
    a.refundUnits += s.refund_units;
    a.refundSales += s.refund_sales;
    if (s.refund_sales > 0 || s.refund_units > 0) a.hasRefundData = true;
    a.orders += s.order_count ?? 0;
    if (s.state_code && s.state_code !== "XX") a.states.add(s.state_code);
    a.channels.add(c);

    if (c === SHOPIFY) a.shopifyGross += s.gross_sales;
    else if (c === AMAZON) a.amazonGross += s.gross_sales;

    if (s.product_title && (!a.title || s.product_title.length > a.title.length))
      a.title = s.product_title;
    if (s.asin && !a.asin) a.asin = s.asin;
  }

  for (const a of Object.values(m)) {
    a.stateCount = a.states.size;
    a.net = a.grossSales - a.refundSales;
  }
  return Object.values(m);
}

// ---------------------------------------------------------------------------
// Reusable toggle
// ---------------------------------------------------------------------------

function Toggle<T extends string>({
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
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
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
// Detail drawer
// ---------------------------------------------------------------------------

function DetailDrawer({
  sku,
  data,
  ch,
  from,
  to,
  open,
  onClose,
}: {
  sku: SkuAgg;
  data: SalesBySku[];
  ch: ChFilter;
  from: string | null;
  to: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // By-state breakdown
  const byState = useMemo(() => {
    const m: Record<string, { gross: number; units: number }> = {};
    for (const s of data) {
      if (s.sku !== sku.sku) continue;
      const c = normalizeChannel(s.channel);
      if (ch !== "all" && c !== ch) continue;
      if (!monthInRange(s.period_start ?? "", from, to)) continue;
      const sc = s.state_code || "XX";
      if (!m[sc]) m[sc] = { gross: 0, units: 0 };
      m[sc].gross += s.gross_sales;
      m[sc].units += s.units;
    }
    return Object.entries(m)
      .map(([state, d]) => ({ state, ...d }))
      .sort((a, b) => b.gross - a.gross);
  }, [data, sku.sku, ch, from, to]);

  // Monthly series
  const monthly = useMemo(() => {
    const m: Record<string, { gross: number; units: number }> = {};
    for (const s of data) {
      if (s.sku !== sku.sku) continue;
      const c = normalizeChannel(s.channel);
      if (ch !== "all" && c !== ch) continue;
      if (!monthInRange(s.period_start ?? "", from, to)) continue;
      const mo = (s.period_start ?? "").slice(0, 7);
      if (!m[mo]) m[mo] = { gross: 0, units: 0 };
      m[mo].gross += s.gross_sales;
      m[mo].units += s.units;
    }
    return Object.entries(m)
      .map(([month, d]) => ({ month, ...d }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [data, sku.sku, ch, from, to]);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-80 sm:w-[420px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{sku.sku}</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-5">
          {sku.title && (
            <p className="text-sm text-muted-foreground" title={`Amazon listing: ${rawTitle(sku.title)}`}>
              {displayTitle(sku.title)}
            </p>
          )}

          {/* Summary */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">Units</span>
            <span className="text-right tabular-nums">{fmt(sku.units)}</span>
            <span className="text-muted-foreground">Gross</span>
            <span className="text-right tabular-nums">${fmtD(sku.grossSales)}</span>
            <span className="text-muted-foreground">Refunds</span>
            <span className="text-right tabular-nums text-red-500">
              {sku.hasRefundData
                ? `$${fmtD(sku.refundSales)} (${sku.refundUnits} u)`
                : "—"}
            </span>
            <span className="text-muted-foreground">Net</span>
            <span className="text-right tabular-nums font-medium">${fmtD(sku.net)}</span>
            <span className="text-muted-foreground">Orders</span>
            <span className="text-right tabular-nums">{fmt(sku.orders)}</span>
            <span className="text-muted-foreground">Channels</span>
            <span className="text-right text-xs">
              {Array.from(sku.channels).sort().map((c) => (
                <Badge key={c} variant="outline" className="ml-1 text-[10px]">
                  {c === "shopify" ? "Shop" : "AMZ"}
                </Badge>
              ))}
            </span>
          </div>

          {/* Channel split */}
          {sku.channels.size > 1 && (
            <div className="text-xs text-muted-foreground">
              Shopify ${fmtD(sku.shopifyGross)} &middot; Amazon ${fmtD(sku.amazonGross)}
            </div>
          )}

          {/* Monthly series */}
          {monthly.length > 0 && (
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                Monthly
              </h4>
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {monthly.map((d) => (
                  <div key={d.month} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{d.month}</span>
                    <span className="tabular-nums">
                      ${fmtD(d.gross)} <span className="text-muted-foreground">({fmt(d.units)} u)</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By state */}
          {byState.length > 0 && (
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                By State
              </h4>
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {byState.map((d) => (
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
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SkusPage() {
  const [ch, setCh] = useState<ChFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("gross");
  const [sortAsc, setSortAsc] = useState(false);
  const [fromMonth, setFromMonth] = useState<string | null>(null);
  const [toMonth, setToMonth] = useState<string | null>(null);

  const { data: skuData, loading } = useSupabaseQuery<SalesBySku>("sales_by_sku");

  const months = useMemo(() => availableMonths(skuData), [skuData]);

  const aggs = useMemo(
    () => aggregate(skuData, ch, fromMonth, toMonth),
    [skuData, ch, fromMonth, toMonth],
  );

  const filtered = useMemo(() => {
    let rows = aggs;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (a) =>
          a.sku.toLowerCase().includes(q) ||
          (a.title ?? "").toLowerCase().includes(q) ||
          (a.asin ?? "").toLowerCase().includes(q),
      );
    }
    // Sort
    const dir = sortAsc ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortKey) {
        case "sku": return a.sku.localeCompare(b.sku) * dir;
        case "units": return (a.units - b.units) * dir;
        case "gross": return (a.grossSales - b.grossSales) * dir;
        case "refunds": return (a.refundSales - b.refundSales) * dir;
        case "net": return (a.net - b.net) * dir;
        case "orders": return (a.orders - b.orders) * dir;
        default: return 0;
      }
    });
    return rows;
  }, [aggs, search, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  const selectedAgg = selected ? aggs.find((a) => a.sku === selected) : null;

  if (loading) return <LoadingState />;

  const totalGross = aggs.reduce((s, a) => s + a.grossSales, 0);
  const totalUnits = aggs.reduce((s, a) => s + a.units, 0);

  function SortHeader({ k, label, right }: { k: SortKey; label: string; right?: boolean }) {
    return (
      <TableHead
        className={`cursor-pointer select-none ${right ? "text-right" : ""}`}
        onClick={() => toggleSort(k)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {sortKey === k && (
            <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
          )}
        </span>
      </TableHead>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header + filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">SKU Performance</h1>
          <p className="text-sm text-muted-foreground">
            {fmt(aggs.length)} SKUs &middot; ${fmt(Math.round(totalGross))} gross &middot; {fmt(totalUnits)} units
          </p>
        </div>
        <Toggle
          options={[
            { value: "all" as ChFilter, label: "All" },
            { value: "amazon" as ChFilter, label: "Amazon" },
            { value: "shopify" as ChFilter, label: "Shopify" },
          ]}
          value={ch}
          onChange={setCh}
        />
      </div>

      {/* Filters row: search + date range */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU, title, ASIN..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">From</span>
          <select
            value={fromMonth ?? ""}
            onChange={(e) => setFromMonth(e.target.value || null)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">Earliest</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-muted-foreground">to</span>
          <select
            value={toMonth ?? ""}
            onChange={(e) => setToMonth(e.target.value || null)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">Latest</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Package className="h-8 w-8" />}
          title="No SKU data"
          description={
            skuData.length === 0
              ? "Run backfill: python -m src.main backfill-shopify-skus && python -m src.main backfill-amazon-skus"
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
                    <SortHeader k="sku" label="SKU" />
                    <TableHead className="hidden md:table-cell">Title</TableHead>
                    <SortHeader k="units" label="Units" right />
                    <SortHeader k="gross" label="Gross $" right />
                    <SortHeader k="refunds" label="Refunds" right />
                    <SortHeader k="net" label="Net $" right />
                    <SortHeader k="orders" label="Orders" right />
                    <TableHead className="text-right w-20">Channels</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 100).map((a) => (
                    <TableRow
                      key={a.sku}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelected(a.sku)}
                    >
                      <TableCell>
                        <span className="font-mono text-xs">{a.sku}</span>
                        {a.asin && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {a.asin}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[180px] truncate text-sm md:table-cell" title={rawTitle(a.title)}>
                        {displayTitle(a.title) || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(a.units)}</TableCell>
                      <TableCell className="text-right tabular-nums">${fmtD(a.grossSales)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {a.hasRefundData ? (
                          <span className="text-red-500">-${fmtD(a.refundSales)}</span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        ${fmtD(a.net)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(a.orders)}</TableCell>
                      <TableCell className="text-right">
                        {Array.from(a.channels).sort().map((c) => (
                          <Badge key={c} variant="outline" className="ml-0.5 text-[9px] px-1">
                            {c === "shopify" ? "S" : "A"}
                          </Badge>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filtered.length > 100 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">
                Showing 100 of {filtered.length} SKUs. Use search to narrow.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Refund footnote */}
      <div className="flex items-start gap-2 text-[10px] text-muted-foreground px-1">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <p>
          <strong>Refunds:</strong> Shopify refunds from order refund line items.
          Amazon refunds only if the SP-API orders report includes return data;
          otherwise shown as &ldquo;—&rdquo;.
          Net = Gross − Refunds when refund data is available.
        </p>
      </div>

      {/* Detail drawer */}
      {selected && selectedAgg && (
        <DetailDrawer
          sku={selectedAgg}
          data={skuData}
          ch={ch}
          from={fromMonth}
          to={toMonth}
          open
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
