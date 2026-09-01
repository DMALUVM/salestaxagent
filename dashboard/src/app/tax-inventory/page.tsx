"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUSGeo, useDarkMode } from "@/lib/use-us-geo";
import { LoadingState } from "@/components/loading";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AWD_NATIONAL,
  UNKNOWN_STATE,
  type StatePeak,
  type TaxInventoryPayload,
} from "@/lib/tax-inventory";
import {
  DollarSign,
  MapPinned,
  Package,
  Info,
  Download,
  Warehouse,
} from "lucide-react";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtD(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

function stateLabel(code: string, name?: string): string {
  if (code === UNKNOWN_STATE) return "Unknown (unmapped FCs)";
  if (code === AWD_NATIONAL) return "AWD (national)";
  return name ? `${code} ${name}` : code;
}

function Tooltip({
  x,
  y,
  code,
  name,
  row,
}: {
  x: number;
  y: number;
  code: string;
  name: string;
  row: StatePeak | undefined;
}) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
      style={{ left: x + 14, top: y - 10 }}
    >
      <p className="font-semibold">
        {code} <span className="font-normal text-muted-foreground">{name}</span>
      </p>
      {row && row.peak_cogs > 0 ? (
        <>
          <p className="mt-0.5 tabular-nums">${fmtD(row.peak_cogs)} peak</p>
          <p className="text-xs text-muted-foreground">
            {row.peak_date} · now ${fmtD(row.current_cogs)} · {fmt(row.current_units)} units
          </p>
          <p className="text-xs text-muted-foreground">
            FBA ${fmtD(row.fba_cogs)} · AWD ${fmtD(row.awd_cogs)}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No FBA ledger $ this year</p>
      )}
    </div>
  );
}

function StateDrawer({
  code,
  name,
  row,
  open,
  onClose,
}: {
  code: string;
  name: string;
  row: StatePeak | undefined;
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
        {!row || row.peak_cogs === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No peak FBA inventory $ at COGS for this state in 2026.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Peak YTD COGS
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                ${fmtD(row.peak_cogs)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                on {row.peak_date}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-muted-foreground">Current on-hand $</span>
              <span className="text-right tabular-nums">${fmtD(row.current_cogs)}</span>
              <span className="text-muted-foreground">FBA</span>
              <span className="text-right tabular-nums">${fmtD(row.fba_cogs)}</span>
              <span className="text-muted-foreground">AWD</span>
              <span className="text-right tabular-nums">${fmtD(row.awd_cogs)}</span>
              <span className="text-muted-foreground">Units (current)</span>
              <span className="text-right tabular-nums">{fmt(row.current_units)}</span>
              <span className="text-muted-foreground">FCs (current)</span>
              <span className="text-right tabular-nums">{row.current_fc_count}</span>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function TaxInventoryPage() {
  const [payload, setPayload] = useState<TaxInventoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(
    null,
  );

  const features = useUSGeo();
  const isDark = useDarkMode();
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tax-inventory?year=2026", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        return body as TaxInventoryPayload;
      })
      .then((d) => {
        if (!cancelled) {
          setPayload(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byState = useMemo(() => {
    const m = new Map<string, StatePeak>();
    for (const s of payload?.states ?? []) m.set(s.state_code, s);
    return m;
  }, [payload]);

  const mapStates = useMemo(
    () => (payload?.states ?? []).filter((s) => s.state_code.length === 2 && s.state_code !== UNKNOWN_STATE && s.state_code !== AWD_NATIONAL),
    [payload],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent, code: string) => {
    setHover({ code, x: e.clientX, y: e.clientY });
  }, []);

  if (loading) return <LoadingState />;
  if (error) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Tax Inventory — Peak COGS by State
        </h1>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  const maxPeak = Math.max(...mapStates.map((s) => s.peak_cogs), 1);
  const totalPeak = mapStates.reduce((s, a) => s + a.peak_cogs, 0);
  const totalCurrent = (payload?.states ?? []).reduce((s, a) => s + a.current_cogs, 0);
  const stateCount = mapStates.filter((s) => s.peak_cogs > 0).length;
  const nameMap = new Map(features.map((f) => [f.stateCode, f.name]));
  const tableRows = [...(payload?.states ?? [])].sort((a, b) => {
    if (a.state_code === AWD_NATIONAL) return 1;
    if (b.state_code === AWD_NATIONAL) return -1;
    if (a.state_code === UNKNOWN_STATE) return 1;
    if (b.state_code === UNKNOWN_STATE) return -1;
    return b.peak_cogs - a.peak_cogs;
  });

  const selectedRow = selected ? byState.get(selected) : undefined;
  const selectedName = selected ? nameMap.get(selected) ?? selected : "";
  const hoverRow = hover ? byState.get(hover.code) : undefined;
  const hoverName = hover ? nameMap.get(hover.code) ?? hover.code : "";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Tax Inventory — Peak COGS by State
          </h1>
          <p className="text-sm text-muted-foreground">
            Physical-nexus inventory $ at sku_costs (COGS). Peak YTD, not the
            ops /inventory table. 2026 · FBA ledger summary.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open("/api/tax-inventory?year=2026&format=csv", "_blank")}
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <DollarSign className="h-5 w-5 text-rose-500" />
            <div>
              <p className="text-lg font-semibold tabular-nums">
                ${fmt(Math.round(totalPeak))}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Sum of state peaks
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <Warehouse className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-lg font-semibold tabular-nums">
                ${fmt(Math.round(totalCurrent))}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Current on-hand $
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-3">
            <MapPinned className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-lg font-semibold tabular-nums">{stateCount}</p>
              <p className="text-[11px] text-muted-foreground">
                States with FBA $
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              2026 YTD · as of {payload?.latest_snapshot ?? "—"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              AWD ${fmtD(payload?.awd.cogs ?? 0)} national
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground">
          {payload?.awd.note} Unmapped FCs stay Unknown — they are not assigned
          to a state. Tulsa Amazon FCs (TUL1/TUL2) are OK FBA when they appear.
          {payload?.missing_cost.sku_count
            ? ` ${payload.missing_cost.sku_count} SKU(s) missing sku_costs (${fmt(payload.missing_cost.units)} units) excluded from $.`
            : ""}
          {payload?.unknown_fcs.length
            ? ` Unmapped FCs: ${payload.unknown_fcs.join(", ")}.`
            : ""}
        </p>
      </div>

      {features.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading map…
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="relative p-0">
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
                  className="h-auto w-full"
                  role="img"
                  aria-label="US tax inventory peak COGS map"
                  onMouseLeave={() => setHover(null)}
                >
                  {features.map(({ stateCode, name, path }) => {
                    const amt = byState.get(stateCode)?.peak_cogs ?? 0;
                    return (
                      <path
                        key={stateCode}
                        d={path}
                        fill={salesColor(amt, maxPeak, isDark)}
                        stroke={isDark ? "#111827" : "#ffffff"}
                        strokeWidth={strokeFor(amt, maxPeak)}
                        className="cursor-pointer transition-all duration-150 hover:brightness-110"
                        onClick={() => setSelected(stateCode)}
                        onMouseMove={(e) => handleMouseMove(e, stateCode)}
                        onMouseLeave={() => setHover(null)}
                      >
                        <title>{name}</title>
                      </path>
                    );
                  })}
                </svg>
              </div>
            </div>
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
                ${fmt(Math.round(maxPeak))}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          code={hover.code}
          name={hoverName}
          row={hoverRow}
        />
      )}

      {selected && (
        <StateDrawer
          code={selected}
          name={selectedName}
          row={selectedRow}
          open={!!selected}
          onClose={() => setSelected(null)}
        />
      )}

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">State table</h2>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-4 py-2 text-right font-medium">Max COGS</th>
                  <th className="px-4 py-2 font-medium">Date of max</th>
                  <th className="px-4 py-2 text-right font-medium">Current $</th>
                  <th className="px-4 py-2 text-right font-medium">FBA</th>
                  <th className="px-4 py-2 text-right font-medium">AWD</th>
                  <th className="px-4 py-2 text-right font-medium">Units</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((s) => (
                  <tr
                    key={s.state_code}
                    className="border-b last:border-0 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 font-medium">
                      {stateLabel(s.state_code, nameMap.get(s.state_code))}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.state_code === AWD_NATIONAL ? "—" : `$${fmtD(s.peak_cogs)}`}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {s.peak_date || "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ${fmtD(s.current_cogs)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ${fmtD(s.fba_cogs)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ${fmtD(s.awd_cogs)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmt(s.current_units)}
                    </td>
                  </tr>
                ))}
                {tableRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-8 text-center text-sm text-muted-foreground"
                    >
                      No ledger-summary days ingested yet. Run{" "}
                      <code>python -m src.main backfill-ledger-summary</code>{" "}
                      or the nightly 06:40 job.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
