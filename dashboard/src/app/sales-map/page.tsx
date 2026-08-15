"use client";

import { useMemo, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { SalesByState } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { useUSGeo, useDarkMode } from "@/lib/use-us-geo";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DollarSign, MapPinned, ShoppingBag, Package } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtDollars(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type YearFilter = "all" | "2024" | "2025" | "2026";

const YEAR_OPTIONS: { value: YearFilter; label: string }[] = [
  { value: "all", label: "All Time" },
  { value: "2024", label: "2024" },
  { value: "2025", label: "2025" },
  { value: "2026", label: "2026 YTD" },
];

interface StateAgg {
  total: number;
  shopify: number;
  amazon: number;
  orders: number;
  shopifyOrders: number;
  amazonOrders: number;
}

// ---------------------------------------------------------------------------
// Aggregate sales by state for selected year
// ---------------------------------------------------------------------------

function aggregateSales(
  sales: SalesByState[],
  year: YearFilter,
): Record<string, StateAgg> {
  const m: Record<string, StateAgg> = {};

  for (const s of sales) {
    // Year filter: check period_start year
    if (year !== "all") {
      const yr = s.period_start?.slice(0, 4);
      if (yr !== year) continue;
    }

    const sc = s.state_code;
    if (!m[sc]) {
      m[sc] = {
        total: 0,
        shopify: 0,
        amazon: 0,
        orders: 0,
        shopifyOrders: 0,
        amazonOrders: 0,
      };
    }

    const ch = normalizeChannel(s.channel);
    m[sc].total += s.gross_sales;
    m[sc].orders += s.order_count;

    if (ch === SHOPIFY) {
      m[sc].shopify += s.gross_sales;
      m[sc].shopifyOrders += s.order_count;
    } else if (ch === AMAZON) {
      m[sc].amazon += s.gross_sales;
      m[sc].amazonOrders += s.order_count;
    }
  }

  return m;
}

// ---------------------------------------------------------------------------
// Color scale: sequential green (quiet → strong)
// ---------------------------------------------------------------------------

function salesColor(
  amount: number,
  max: number,
  isDark: boolean,
): string {
  if (max <= 0 || amount <= 0) {
    return isDark ? "#1f2937" : "#f3f4f6"; // neutral gray
  }

  // Log scale so small states still get some color
  const t = Math.min(Math.log(amount + 1) / Math.log(max + 1), 1);

  if (isDark) {
    // Dark mode: dark gray → rich green
    const r = Math.round(30 + (20 - 30) * t);
    const g = Math.round(41 + (120 - 41) * t);
    const b = Math.round(55 + (50 - 55) * t);
    return `rgb(${r},${g},${b})`;
  }

  // Light mode: very light green → strong green
  const r = Math.round(243 + (22 - 243) * t);
  const g = Math.round(244 + (163 - 244) * t);
  const b = Math.round(246 + (74 - 246) * t);
  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------------------
// State detail drawer
// ---------------------------------------------------------------------------

function StateDrawer({
  code,
  name,
  agg,
  open,
  onClose,
}: {
  code: string;
  name: string;
  agg: StateAgg | undefined;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-80 sm:w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="text-lg">{code}</span>
            <span className="text-base font-normal text-muted-foreground">
              {name}
            </span>
          </SheetTitle>
        </SheetHeader>

        {!agg || agg.total === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No sales recorded for this state in the selected period.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Total */}
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Total Gross Sales
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                ${fmtDollars(agg.total)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {fmt(agg.orders)} orders
              </p>
            </div>

            {/* Channel split */}
            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                By Channel
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <ShoppingBag className="h-3.5 w-3.5 text-muted-foreground" />
                  Shopify
                </span>
                <span className="text-right tabular-nums">
                  ${fmtDollars(agg.shopify)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmt(agg.shopifyOrders)})
                  </span>
                </span>

                <span className="flex items-center gap-2">
                  <Package className="h-3.5 w-3.5 text-muted-foreground" />
                  Amazon
                </span>
                <span className="text-right tabular-nums">
                  ${fmtDollars(agg.amazon)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmt(agg.amazonOrders)})
                  </span>
                </span>
              </div>
            </div>

            {/* Channel bar */}
            {agg.total > 0 && (
              <div className="space-y-1">
                <div className="flex h-2 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-violet-500"
                    style={{
                      width: `${(agg.shopify / agg.total) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-emerald-500"
                    style={{
                      width: `${(agg.amazon / agg.total) * 100}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>
                    Shopify{" "}
                    {((agg.shopify / agg.total) * 100).toFixed(0)}%
                  </span>
                  <span>
                    Amazon{" "}
                    {((agg.amazon / agg.total) * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SalesMapPage() {
  const [year, setYear] = useState<YearFilter>("2026");
  const [selected, setSelected] = useState<string | null>(null);

  const { data: sales, loading } = useSupabaseQuery<SalesByState>(
    "sales_by_state",
  );
  const features = useUSGeo();
  const isDark = useDarkMode();

  const aggs = useMemo(() => aggregateSales(sales, year), [sales, year]);

  if (loading) return <LoadingState />;

  // Summary stats
  const stateCount = Object.keys(aggs).length;
  const totalSales = Object.values(aggs).reduce(
    (s, a) => s + a.total,
    0,
  );
  const totalOrders = Object.values(aggs).reduce(
    (s, a) => s + a.orders,
    0,
  );
  const maxSales = Math.max(
    ...Object.values(aggs).map((a) => a.total),
    1,
  );
  const minSales = Math.min(
    ...Object.values(aggs)
      .filter((a) => a.total > 0)
      .map((a) => a.total),
    0,
  );

  // Name lookup from features
  const nameMap = new Map(features.map((f) => [f.stateCode, f.name]));

  const selectedAgg = selected ? aggs[selected] : undefined;
  const selectedName = selected
    ? nameMap.get(selected) ?? selected
    : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Sales Map
          </h1>
          <p className="text-sm text-muted-foreground">
            Gross sales volume by state
          </p>
        </div>
        {/* Year toggles */}
        <div className="flex gap-1">
          {YEAR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setYear(opt.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                year === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <DollarSign className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-xl font-semibold tabular-nums">
                ${fmt(Math.round(totalSales))}
              </p>
              <p className="text-xs text-muted-foreground">
                Total gross sales
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <ShoppingBag className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {fmt(totalOrders)}
              </p>
              <p className="text-xs text-muted-foreground">Orders</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <MapPinned className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xl font-semibold tabular-nums">
                {stateCount}
              </p>
              <p className="text-xs text-muted-foreground">
                States with sales
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Badge variant="outline" className="text-xs">
              {YEAR_OPTIONS.find((o) => o.value === year)?.label}
            </Badge>
            <div>
              <p className="text-xs text-muted-foreground">
                {minSales > 0
                  ? `$${fmt(Math.round(minSales))} – $${fmt(Math.round(maxSales))}`
                  : "No sales data"}
              </p>
              <p className="text-xs text-muted-foreground">
                Min – Max by state
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Map */}
      {features.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading map…
        </div>
      ) : (
        <Card>
          <CardContent className="p-4">
            <div className="relative w-full overflow-hidden rounded-lg">
              <svg
                viewBox="0 0 975 610"
                className="w-full h-auto"
                role="img"
                aria-label="US sales volume map"
              >
                {features.map(({ stateCode, name, path }) => (
                  <path
                    key={stateCode}
                    d={path}
                    fill={salesColor(
                      aggs[stateCode]?.total ?? 0,
                      maxSales,
                      isDark,
                    )}
                    stroke={isDark ? "#111827" : "#ffffff"}
                    strokeWidth={0.75}
                    className="cursor-pointer transition-opacity duration-150 hover:opacity-75"
                    onClick={() => setSelected(stateCode)}
                  >
                    <title>
                      {stateCode} — {name}
                      {aggs[stateCode]
                        ? ` — $${fmt(Math.round(aggs[stateCode].total))}`
                        : ""}
                    </title>
                  </path>
                ))}
              </svg>
            </div>

            {/* Legend */}
            <div className="mt-3 flex items-center gap-2 px-1">
              <span className="text-[11px] text-muted-foreground">$0</span>
              <div
                className="h-2.5 flex-1 rounded-full"
                style={{
                  background: isDark
                    ? "linear-gradient(to right, #1f2937, #147832)"
                    : "linear-gradient(to right, #f3f4f6, #16a34a)",
                }}
              />
              <span className="text-[11px] text-muted-foreground">
                ${fmt(Math.round(maxSales))}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* State detail drawer */}
      {selected && (
        <StateDrawer
          code={selected}
          name={selectedName}
          agg={selectedAgg}
          open={!!selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
