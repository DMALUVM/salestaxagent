"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useSupabaseQuery, useSalesDaily } from "@/lib/hooks";
import type { SalesDaily, SalesByState } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON } from "@/lib/channels";
import { useUSGeo, useDarkMode } from "@/lib/use-us-geo";
import { LoadingState } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import {
  Shield,
  Download,
  MapPinned,
  ShoppingBag,
  Package,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Range = "7d" | "30d" | "mtd" | "custom";
type ChFilter = "all" | "shopify" | "amazon";

interface DayRow {
  date: string;
  shopify: number;
  amazon: number;
  total: number;
  shopifyOrders: number;
  amazonOrders: number;
}

interface StateAgg {
  total: number;
  shopify: number;
  amazon: number;
  orders: number;
  shopifyOrders: number;
  amazonOrders: number;
}

function SetupPrompt() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
      <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Set{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_URL
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          NEXT_PUBLIC_SUPABASE_ANON_KEY
        </code>{" "}
        in{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          .env.local
        </code>
        .
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date range computation (shared by daily table + map)
// ---------------------------------------------------------------------------

function computeRange(
  range: Range,
  customStart: string,
  customEnd: string,
): { startDate: string; endDate: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  if (range === "7d") {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    return { startDate: d.toISOString().slice(0, 10), endDate: todayStr };
  }
  if (range === "30d") {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    return { startDate: d.toISOString().slice(0, 10), endDate: todayStr };
  }
  if (range === "mtd") {
    const yd = new Date(today);
    yd.setDate(yd.getDate() - 1);
    const ydStr = yd.toISOString().slice(0, 10);
    return { startDate: ydStr.slice(0, 8) + "01", endDate: todayStr };
  }
  return {
    startDate: customStart || todayStr,
    endDate: customEnd || todayStr,
  };
}

// ---------------------------------------------------------------------------
// Map color ramp (same as /sales-map)
// ---------------------------------------------------------------------------

function salesColor(amount: number, max: number, isDark: boolean): string {
  if (max <= 0 || amount <= 0) return isDark ? "#1f2937" : "#f3f4f6";
  const t = Math.min(Math.log(amount + 1) / Math.log(max + 1), 1);
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

function strokeFor(amount: number, max: number): number {
  if (max <= 0 || amount <= 0) return 0.5;
  const ratio = amount / max;
  if (ratio > 0.5) return 1.8;
  if (ratio > 0.25) return 1.2;
  return 0.5;
}

// ---------------------------------------------------------------------------
// State drawer
// ---------------------------------------------------------------------------

function StateDrawer({
  code,
  name,
  agg,
  mapChannel,
  rangeLabel,
  open,
  onClose,
}: {
  code: string;
  name: string;
  agg: StateAgg | undefined;
  mapChannel: ChFilter;
  rangeLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const displayAmt =
    mapChannel === "shopify"
      ? agg?.shopify ?? 0
      : mapChannel === "amazon"
        ? agg?.amazon ?? 0
        : agg?.total ?? 0;
  const displayOrd =
    mapChannel === "shopify"
      ? agg?.shopifyOrders ?? 0
      : mapChannel === "amazon"
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
            No sales for {code} in {rangeLabel}.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Gross Sales &middot; {rangeLabel}
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
                Channel Breakdown
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
            </div>

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
                    className="bg-amber-500"
                    style={{
                      width: `${(agg.amazon / agg.total) * 100}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>
                    Shopify {((agg.shopify / agg.total) * 100).toFixed(0)}%
                  </span>
                  <span>
                    Amazon {((agg.amazon / agg.total) * 100).toFixed(0)}%
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

export default function SalesPage() {
  if (!isConfigured()) return <SetupPrompt />;

  const { data: salesDaily, loading: l1, error } = useSalesDaily<SalesDaily>();
  const { data: salesByState, loading: l2 } =
    useSupabaseQuery<SalesByState>("sales_by_state");

  const [range, setRange] = useState<Range>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [mapOpen, setMapOpen] = useState(true);
  const [mapChannel, setMapChannel] = useState<ChFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    code: string;
    x: number;
    y: number;
  } | null>(null);

  const features = useUSGeo();
  const isDark = useDarkMode();

  const { startDate, endDate } = useMemo(
    () => computeRange(range, customStart, customEnd),
    [range, customStart, customEnd],
  );

  const rangeLabel =
    range === "7d"
      ? "7 Days"
      : range === "30d"
        ? "30 Days"
        : range === "mtd"
          ? "MTD"
          : `${startDate} – ${endDate}`;

  // ── Daily table rows (from sales_daily) ──
  const rows = useMemo(() => {
    const map = new Map<string, DayRow>();
    for (const row of salesDaily) {
      if (row.sale_date < startDate || row.sale_date > endDate) continue;
      let dr = map.get(row.sale_date);
      if (!dr) {
        dr = {
          date: row.sale_date,
          shopify: 0,
          amazon: 0,
          total: 0,
          shopifyOrders: 0,
          amazonOrders: 0,
        };
        map.set(row.sale_date, dr);
      }
      const ch = normalizeChannel(row.channel);
      const gross = Number(row.gross_sales);
      const orders = Number(row.order_count);
      if (ch === SHOPIFY) {
        dr.shopify += gross;
        dr.shopifyOrders += orders;
      } else if (ch === AMAZON) {
        dr.amazon += gross;
        dr.amazonOrders += orders;
      }
      dr.total = dr.shopify + dr.amazon;
    }
    return Array.from(map.values()).sort((a, b) =>
      b.date > a.date ? 1 : -1,
    );
  }, [salesDaily, startDate, endDate]);

  const totals = useMemo(() => {
    let shopify = 0,
      amazon = 0,
      total = 0;
    for (const r of rows) {
      shopify += r.shopify;
      amazon += r.amazon;
      total += r.total;
    }
    return { shopify, amazon, total };
  }, [rows]);

  // ── Map aggregation (from sales_by_state) ──
  const stateAggs = useMemo(() => {
    const m: Record<string, StateAgg> = {};
    for (const s of salesByState) {
      const ps = s.period_start ?? "";
      const pe = s.period_end ?? "";
      // Include if period overlaps the selected range
      if (pe < startDate || ps > endDate) continue;
      const ch = normalizeChannel(s.channel);
      if (mapChannel !== "all" && ch !== mapChannel) continue;
      const sc = s.state_code;
      if (!m[sc])
        m[sc] = {
          total: 0,
          shopify: 0,
          amazon: 0,
          orders: 0,
          shopifyOrders: 0,
          amazonOrders: 0,
        };
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
  }, [salesByState, startDate, endDate, mapChannel]);

  const mapMax = useMemo(() => {
    const vals = Object.values(stateAggs).map((a) => a.total);
    return Math.max(...vals, 1);
  }, [stateAggs]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent, code: string) => {
      setHover({ code, x: e.clientX, y: e.clientY });
    },
    [],
  );

  function exportCSV() {
    const header =
      "Date,Shopify $,Amazon $,Total,Shopify Orders,Amazon Orders\n";
    const body = rows
      .map(
        (r) =>
          `${r.date},${r.shopify.toFixed(2)},${r.amazon.toFixed(2)},${r.total.toFixed(2)},${r.shopifyOrders},${r.amazonOrders}`,
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales_${range}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (l1 || l2) return <LoadingState />;

  const nameMap = new Map(features.map((f) => [f.stateCode, f.name]));
  const stateCount = Object.keys(stateAggs).length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Failed to load sales data: {error}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sales</h1>
        <p className="text-sm text-muted-foreground">
          Order-date basis &middot; Amazon: Pacific tz &middot; Shopify:
          Eastern tz
        </p>
      </div>

      {/* Range picker */}
      <div className="flex flex-wrap items-center gap-2">
        {(["7d", "30d", "mtd", "custom"] as Range[]).map((v) => (
          <Button
            key={v}
            variant={range === v ? "default" : "outline"}
            size="sm"
            onClick={() => setRange(v)}
          >
            {v === "7d"
              ? "7 Days"
              : v === "30d"
                ? "30 Days"
                : v === "mtd"
                  ? "MTD"
                  : "Custom"}
          </Button>
        ))}
        {range === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-sm"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-sm"
            />
          </div>
        )}
      </div>

      {/* Summary strip */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Total
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(totals.total))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Shopify
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(totals.shopify))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Amazon
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              ${fmt(Math.round(totals.amazon))}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Map section ── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setMapOpen(!mapOpen)}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <MapPinned className="h-4 w-4 text-muted-foreground" />
              Sales by State &middot; {rangeLabel}
              {mapOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
            {mapOpen && (
              <div className="inline-flex rounded-lg border bg-muted p-0.5">
                {(["all", "shopify", "amazon"] as ChFilter[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setMapChannel(v)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      mapChannel === v
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {v === "all"
                      ? "Total"
                      : v === "shopify"
                        ? "Shopify"
                        : "Amazon"}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        {mapOpen && (
          <CardContent className="p-0">
            {features.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                Loading map…
              </div>
            ) : (
              <>
                <div className="px-4 pb-1">
                  <svg
                    viewBox="0 0 975 610"
                    className="w-full h-auto"
                    role="img"
                    aria-label="US sales by state"
                    onMouseLeave={() => setHover(null)}
                  >
                    {features.map(({ stateCode, path }) => {
                      const amt = stateAggs[stateCode]?.total ?? 0;
                      return (
                        <path
                          key={stateCode}
                          d={path}
                          fill={salesColor(amt, mapMax, isDark)}
                          stroke={isDark ? "#111827" : "#ffffff"}
                          strokeWidth={strokeFor(amt, mapMax)}
                          className="cursor-pointer transition-all duration-150 hover:brightness-110"
                          onClick={() => setSelected(stateCode)}
                          onMouseMove={(e) => handleMouseMove(e, stateCode)}
                          onMouseLeave={() => setHover(null)}
                        />
                      );
                    })}
                  </svg>
                </div>
                {/* Legend */}
                <div className="flex items-center gap-2 px-5 pb-3">
                  <span className="text-[11px] text-muted-foreground">$0</span>
                  <div
                    className="h-2 flex-1 rounded-full"
                    style={{
                      background: isDark
                        ? "linear-gradient(to right, #1c1917, #78350f, #c2410c, #e11d48, #be185d)"
                        : "linear-gradient(to right, #f5f5f4, #fef3c7, #fdba74, #f87171, #be185d)",
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    ${fmt(Math.round(mapMax))}
                  </span>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {stateCount} states
                  </span>
                </div>
              </>
            )}
          </CardContent>
        )}
      </Card>

      {/* Hover tooltip */}
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
          style={{ left: hover.x + 14, top: hover.y - 10 }}
        >
          <p className="font-semibold">
            {hover.code}{" "}
            <span className="font-normal text-muted-foreground">
              {nameMap.get(hover.code) ?? hover.code}
            </span>
          </p>
          {stateAggs[hover.code] ? (
            <>
              <p className="mt-0.5 tabular-nums">
                ${fmtD(stateAggs[hover.code].total)}
              </p>
              <p className="text-xs text-muted-foreground">
                {fmt(stateAggs[hover.code].orders)} orders &middot;{" "}
                {rangeLabel}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              No sales &middot; {rangeLabel}
            </p>
          )}
        </div>
      )}

      {/* State detail drawer */}
      {selected && (
        <StateDrawer
          code={selected}
          name={nameMap.get(selected) ?? selected}
          agg={stateAggs[selected]}
          mapChannel={mapChannel}
          rangeLabel={rangeLabel}
          open={!!selected}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Data table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">
            Daily Breakdown
          </CardTitle>
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Shopify $</TableHead>
                <TableHead className="text-right">Amazon $</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Shopify Orders</TableHead>
                <TableHead className="text-right">Amazon Orders</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-8"
                  >
                    No data for selected range.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, i) => (
                  <TableRow
                    key={r.date}
                    className={i % 2 === 1 ? "bg-muted/30" : ""}
                  >
                    <TableCell className="font-medium">{r.date}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${fmt(Math.round(r.shopify))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${fmt(Math.round(r.amazon))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      ${fmt(Math.round(r.total))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(r.shopifyOrders)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt(r.amazonOrders)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Footer */}
      <p className="text-xs text-muted-foreground">
        Amazon: item-price by purchase-date, Pacific tz, excl. cancelled.
        Shopify: subtotal by created_at, Eastern tz. Map uses monthly
        sales_by_state (state-level). Not settlement deposits. Not tax advice.
      </p>
    </div>
  );
}
