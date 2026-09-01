"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useSupabaseQuery } from "@/lib/hooks";
import type { SalesByState } from "@/lib/types";
import { useUSGeo, useDarkMode } from "@/lib/use-us-geo";
import { LoadingState } from "@/components/loading";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DollarSign, MapPinned, ShoppingBag, Package, Info } from "lucide-react";
import {
  aggregateSalesMap,
  type ChannelFilter,
  type MonthFilter,
  type StateAgg,
  type YearFilter,
} from "@/lib/sales-map-agg";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const YEARS: { value: YearFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "2024", label: "2024" },
  { value: "2025", label: "2025" },
  { value: "2026", label: "2026" },
];

const MONTH_NAMES = [
  "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CHANNELS: { value: ChannelFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "amazon", label: "Amazon" },
  { value: "shopify", label: "Shopify" },
];

// ---------------------------------------------------------------------------
// Color ramp: gray → amber → orange → deep rose (log-scaled)
// ---------------------------------------------------------------------------

function salesColor(amount: number, max: number, isDark: boolean): string {
  if (max <= 0 || amount <= 0)
    return isDark ? "#1f2937" : "#f3f4f6";

  const t = Math.min(Math.log(amount + 1) / Math.log(max + 1), 1);

  // 5-stop ramp via linear interpolation
  // Light: #f5f5f4 → #fef3c7 → #fdba74 → #f87171 → #be185d
  // Dark:  #1c1917 → #78350f → #c2410c → #e11d48 → #be185d
  const stops = isDark
    ? [
        [28, 25, 23],
        [120, 53, 15],
        [194, 65, 12],
        [225, 29, 72],
        [190, 24, 93],
      ]
    : [
        [245, 245, 244],
        [254, 243, 199],
        [253, 186, 116],
        [248, 113, 113],
        [190, 24, 93],
      ];

  const seg = t * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  const [r, g, b] = stops[i].map((c, j) =>
    Math.round(c + (stops[i + 1][j] - c) * f),
  );
  return `rgb(${r},${g},${b})`;
}

// Rank-based stroke weight: top 5 get heavier borders
function strokeFor(amount: number, max: number): number {
  if (max <= 0 || amount <= 0) return 0.5;
  const ratio = amount / max;
  if (ratio > 0.5) return 1.8;
  if (ratio > 0.25) return 1.2;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Tooltip (follows cursor)
// ---------------------------------------------------------------------------

function Tooltip({
  x,
  y,
  code,
  name,
  agg,
  channel,
  periodLabel,
}: {
  x: number;
  y: number;
  code: string;
  name: string;
  agg: StateAgg | undefined;
  channel: ChannelFilter;
  periodLabel: string;
}) {
  const chLabel =
    channel === "all"
      ? "All channels"
      : channel === "amazon"
      ? "Amazon"
      : "Shopify";
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
      style={{ left: x + 14, top: y - 10 }}
    >
      <p className="font-semibold">
        {code} <span className="font-normal text-muted-foreground">{name}</span>
      </p>
      {agg && agg.total > 0 ? (
        <>
          <p className="mt-0.5 tabular-nums">${fmtD(agg.total)}</p>
          <p className="text-xs text-muted-foreground">
            {fmt(agg.orders)} orders &middot; {chLabel} &middot; {periodLabel}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No sales &middot; {periodLabel}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State detail drawer
// ---------------------------------------------------------------------------

function StateDrawer({
  code,
  name,
  agg,
  channel,
  periodLabel,
  open,
  onClose,
}: {
  code: string;
  name: string;
  agg: StateAgg | undefined;
  channel: ChannelFilter;
  periodLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const displayAmt =
    channel === "shopify"
      ? agg?.shopify ?? 0
      : channel === "amazon"
      ? agg?.amazon ?? 0
      : agg?.total ?? 0;
  const displayOrd =
    channel === "shopify"
      ? agg?.shopifyOrders ?? 0
      : channel === "amazon"
      ? agg?.amazonOrders ?? 0
      : agg?.orders ?? 0;

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

        {!agg || displayAmt === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No sales for this state in {periodLabel} ({CHANNELS.find(c => c.value === channel)?.label}).
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Gross Sales &middot; {periodLabel}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                ${fmtD(displayAmt)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {fmt(displayOrd)} orders
              </p>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Source mix (ship-to)
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <ShoppingBag className="h-3.5 w-3.5 text-violet-500" />
                  Shopify
                </span>
                <span className="text-right tabular-nums">
                  ${fmtD(agg.shopify)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmt(agg.shopifyOrders)})
                  </span>
                </span>
                {(agg.shopifySeller > 0 || agg.shopifyShop > 0 || agg.shopifySub > 0) && (
                  <>
                    <span className="pl-6 text-xs text-muted-foreground">Seller</span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">
                      ${fmtD(agg.shopifySeller)}
                    </span>
                    <span className="pl-6 text-xs text-muted-foreground">Shop</span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">
                      ${fmtD(agg.shopifyShop)}
                    </span>
                    <span className="pl-6 text-xs text-muted-foreground">Subscription</span>
                    <span className="text-right text-xs tabular-nums text-muted-foreground">
                      ${fmtD(agg.shopifySub)}
                    </span>
                  </>
                )}
                <span className="flex items-center gap-2">
                  <Package className="h-3.5 w-3.5 text-amber-500" />
                  Amazon
                </span>
                <span className="text-right tabular-nums">
                  ${fmtD(agg.amazon)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmt(agg.amazonOrders)})
                  </span>
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Amazon + Shopify = ${fmtD(agg.amazon + agg.shopify)}
                {Math.abs(agg.amazon + agg.shopify - agg.total) > 0.01
                  ? ` · leftover $${fmtD(agg.total - agg.amazon - agg.shopify)}`
                  : " · matches total"}
              </p>
            </div>

            {agg.total > 0 && (
              <div className="space-y-1">
                <div className="flex h-2 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-violet-500"
                    style={{ width: `${(agg.shopify / agg.total) * 100}%` }}
                  />
                  <div
                    className="bg-amber-500"
                    style={{ width: `${(agg.amazon / agg.total) * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Shopify {((agg.shopify / agg.total) * 100).toFixed(0)}%</span>
                  <span>Amazon {((agg.amazon / agg.total) * 100).toFixed(0)}%</span>
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border border-muted bg-muted/20 p-3">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-[10px] text-muted-foreground">
                Destination (ship-to) from <code>sales_by_state.gross_sales</code>
                — Amazon <code>amazon_spapi</code> ship-state + Shopify
                shipping address. Shop + subscription count as Shopify.
                Quarantined tax dumps are skipped. Not ship-from / FC.
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Toggle button group
// ---------------------------------------------------------------------------

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
// Page
// ---------------------------------------------------------------------------

export default function SalesMapPage() {
  const [year, setYear] = useState<YearFilter>("2026");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [month, setMonth] = useState<MonthFilter>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    code: string;
    x: number;
    y: number;
  } | null>(null);

  const { data: sales, loading } = useSupabaseQuery<SalesByState>(
    "sales_by_state",
  );
  const features = useUSGeo();
  const isDark = useDarkMode();
  const svgRef = useRef<SVGSVGElement>(null);

  // Derive available months for the selected year (sorted)
  const availableMonths = useMemo(() => {
    if (year === "all") return [];
    const set = new Set<string>();
    for (const s of sales) {
      const ps = s.period_start ?? "";
      if (ps.slice(0, 4) === year) set.add(ps.slice(0, 7));
    }
    return Array.from(set).sort();
  }, [sales, year]);

  // Reset month when year changes
  const handleYearChange = useCallback((y: YearFilter) => {
    setYear(y);
    setMonth(null); // reset to full year
  }, []);

  const { byState: aggs, unmapped, skippedQuarantine } = useMemo(
    () => aggregateSalesMap(sales, year, channel, month, availableMonths),
    [sales, year, channel, month, availableMonths],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, code: string) => {
      setHover({ code, x: e.clientX, y: e.clientY });
    },
    [],
  );

  if (loading) return <LoadingState />;

  const vals = Object.values(aggs);
  const stateCount = Object.keys(aggs).length;
  const totalSales = vals.reduce((s, a) => s + a.total, 0) + unmapped.total;
  const totalOrders = vals.reduce((s, a) => s + a.orders, 0) + unmapped.orders;
  const totalAmazon = vals.reduce((s, a) => s + a.amazon, 0) + unmapped.amazon;
  const totalShopify = vals.reduce((s, a) => s + a.shopify, 0) + unmapped.shopify;
  const caAgg = aggs.CA;
  const maxSales = Math.max(...vals.map((a) => a.total), 1);
  const posVals = vals.filter((a) => a.total > 0).map((a) => a.total);
  const minSales = posVals.length > 0 ? Math.min(...posVals) : 0;
  const midSales = posVals.length > 0
    ? posVals.sort((a, b) => a - b)[Math.floor(posVals.length / 2)]
    : 0;

  const nameMap = new Map(features.map((f) => [f.stateCode, f.name]));

  // Build human-readable period label
  const resolvedMonth =
    month === "latest" && availableMonths.length > 0
      ? availableMonths[availableMonths.length - 1]
      : month;
  let periodLabel: string;
  if (year === "all") {
    periodLabel = "All Time";
  } else if (resolvedMonth && resolvedMonth !== "latest") {
    const mm = parseInt(resolvedMonth.slice(5, 7), 10);
    periodLabel = `${MONTH_NAMES[mm]} ${year}`;
  } else {
    periodLabel = `${year} YTD`;
  }

  const selectedAgg = selected ? aggs[selected] : undefined;
  const selectedName = selected ? nameMap.get(selected) ?? selected : "";
  const hoverAgg = hover ? aggs[hover.code] : undefined;
  const hoverName = hover ? nameMap.get(hover.code) ?? hover.code : "";

  return (
    <div className="space-y-5">
      {/* Header + filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sales Map</h1>
          <p className="text-sm text-muted-foreground">
            Gross sales by destination (ship-to) state
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup options={CHANNELS} value={channel} onChange={setChannel} />
          <ToggleGroup options={YEARS} value={year} onChange={handleYearChange} />
        </div>
      </div>

      {/* Month selector — only when a single year is selected */}
      {year !== "all" && availableMonths.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => setMonth(null)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              month === null
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            Full Year
          </button>
          <button
            onClick={() => setMonth("latest")}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              month === "latest" ||
              (resolvedMonth === availableMonths[availableMonths.length - 1] &&
                month === "latest")
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            Latest
          </button>
          <span className="mx-1 text-muted-foreground/30">|</span>
          {availableMonths.map((ym) => {
            const mm = parseInt(ym.slice(5, 7), 10);
            const active = month === ym;
            return (
              <button
                key={ym}
                onClick={() => setMonth(ym)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {MONTH_NAMES[mm]}
              </button>
            );
          })}
        </div>
      )}

      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <DollarSign className="h-5 w-5 text-rose-500" />
            <div>
              <p className="text-lg font-semibold tabular-nums">
                ${fmt(Math.round(totalSales))}
              </p>
              <p className="text-[11px] text-muted-foreground">Gross sales (ship-to)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <ShoppingBag className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-lg font-semibold tabular-nums">
                {fmt(totalOrders)}
              </p>
              <p className="text-[11px] text-muted-foreground">Orders</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <MapPinned className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-lg font-semibold tabular-nums">
                {stateCount}
              </p>
              <p className="text-[11px] text-muted-foreground">States</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              {periodLabel} &middot;{" "}
              {CHANNELS.find((c) => c.value === channel)?.label}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {minSales > 0
                ? `$${fmt(Math.round(minSales))} – $${fmt(Math.round(midSales))} – $${fmt(Math.round(maxSales))}`
                : "No sales data"}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Min – Median – Max
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/20 px-3 py-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="space-y-0.5 text-[11px] text-muted-foreground">
          <p>
            {periodLabel} · <code className="text-[10px]">sales_by_state.gross_sales</code> ·
            destination (ship-to), not ship-from. Amazon{" "}
            <code className="text-[10px]">amazon_spapi</code> ${fmt(Math.round(totalAmazon))} +
            Shopify (seller + Shop + sub) ${fmt(Math.round(totalShopify))}. Quarantined
            tax dumps skipped
            {skippedQuarantine > 0 ? ` ($${fmt(Math.round(skippedQuarantine))} not shown)` : ""}.
          </p>
          {caAgg && channel === "all" && (year === "2026" || year === "2025") && month === null && (
            <p className="tabular-nums">
              CA {year}: Amazon ${fmt(Math.round(caAgg.amazon))} + Shopify $
              {fmt(Math.round(caAgg.shopify))} = ${fmt(Math.round(caAgg.total))}
            </p>
          )}
          <p>
            Blank / unmapped ship-to:{" "}
            {unmapped.total > 0
              ? `$${fmtD(unmapped.total)} (${fmt(unmapped.orders)} orders) — not on the map`
              : "none"}
          </p>
        </div>
      </div>

      {/* Map */}
      {features.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading map…
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="relative p-0">
            {/* Subtle shadow under map for depth */}
            <div className="p-4 pb-2">
              <div
                className="rounded-lg"
                style={{
                  boxShadow: isDark
                    ? "0 4px 24px rgba(0,0,0,0.4)"
                    : "0 4px 24px rgba(0,0,0,0.08)",
                }}
              >
                <svg
                  ref={svgRef}
                  viewBox="0 0 975 610"
                  className="w-full h-auto"
                  role="img"
                  aria-label="US sales volume map"
                  onMouseLeave={() => setHover(null)}
                >
                  {features.map(({ stateCode, name, path }) => {
                    const amt = aggs[stateCode]?.total ?? 0;
                    return (
                      <path
                        key={stateCode}
                        d={path}
                        fill={salesColor(amt, maxSales, isDark)}
                        stroke={isDark ? "#111827" : "#ffffff"}
                        strokeWidth={strokeFor(amt, maxSales)}
                        className="cursor-pointer transition-all duration-150 hover:brightness-110"
                        onClick={() => setSelected(stateCode)}
                        onMouseMove={(e) => handleMouseMove(e, stateCode)}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                </svg>
              </div>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-2 px-5 pb-4">
              <span className="text-[11px] text-muted-foreground">$0</span>
              <div
                className="h-2.5 flex-1 rounded-full"
                style={{
                  background: isDark
                    ? "linear-gradient(to right, #1c1917, #78350f, #c2410c, #e11d48, #be185d)"
                    : "linear-gradient(to right, #f5f5f4, #fef3c7, #fdba74, #f87171, #be185d)",
                }}
              />
              <span className="text-[11px] text-muted-foreground">
                ${fmt(Math.round(maxSales))}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hover tooltip */}
      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          code={hover.code}
          name={hoverName}
          agg={hoverAgg}
          channel={channel}
          periodLabel={periodLabel}
        />
      )}

      {/* State detail drawer */}
      {selected && (
        <StateDrawer
          code={selected}
          name={selectedName}
          agg={selectedAgg}
          channel={channel}
          periodLabel={periodLabel}
          open={!!selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
