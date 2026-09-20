"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { isConfigured } from "@/lib/supabase";
import { money, pct, type FunnelWindow } from "@/lib/shopify-funnel";
import { Shield } from "lucide-react";

type Step = { key: string; label: string; count: number | null; note?: string | null };
type Drop = {
  from: string; fromLabel: string; to: string; toLabel: string;
  lost: number | null; rate: number | null; nested: boolean | null; present: boolean;
};
type AbandonRow = {
  checkout_id: string;
  checkout_name: string | null;
  checkout_date: string;
  total_price: number | null;
  recovered: boolean;
  line_items: Array<{ title?: string | null; quantity?: number }>;
  triage_severity: "hold_for_review" | "needs_eyes" | "noise" | null;
  shipping_address_started?: boolean | null;
  has_discount?: boolean | null;
  discount_codes?: string[] | null;
  recovery_status?: "open" | "recovered" | null;
};
type Payload = {
  available: boolean;
  empty?: boolean;
  error?: string | null;
  setupHint?: string | null;
  windowDays?: FunnelWindow;
  start?: string;
  end?: string;
  funnel?: {
    sessions: number | null; pdpSessions: number | null;
    addToCart: number | null; checkoutStarted: number | null; purchases: number | null;
  };
  steps?: Step[];
  dropOff?: Drop[];
  biggestLeak?: { fromLabel: string; toLabel: string; lost: number; rate: number | null } | null;
  conversionRate?: number | null;
  abandoned?: {
    count: number; recovered: number; open: number;
    recoveryRate: number | null; openValue: number;
    topProducts: Array<{ title: string; handle: string | null; quantity: number; amount: number; checkouts: number }>;
    friction?: {
      open: number; shippingAddressStarted: number; shippingAddressMissing: number;
      hasDiscount: number; shippingRateUnknown: number; paymentAttemptUnknown: number;
    };
    productLeak?: {
      note: string;
      kinds: Array<{ kind: string; open: number; recovered: number; openValue: number; recoveryRate: number | null }>;
      products: Array<{ title: string; handle: string | null; kind: string; open: number; recovered: number; openValue: number; recoveryRate: number | null }>;
    };
    rows: AbandonRow[];
  };
  splits?: {
    device: Array<{ device: string; sessions: number | null; addToCart: number | null; purchases: number | null }>;
    channel?: Array<{ channel: string; sessions: number | null; addToCart: number | null; purchases: number | null }>;
    landingPage: Array<{ path: string; sessions: number | null; addToCart: number | null; purchases: number | null }>;
  };
  status?: {
    last_synced_at?: string | null;
    missing_scopes?: string[];
    last_error?: string | null;
    funnel_ok?: boolean;
    abandon_ok?: boolean;
  } | null;
  definitions?: Array<[string, string]>;
};

function severityBadge(s: AbandonRow["triage_severity"]) {
  if (s === "needs_eyes") return <Badge variant="destructive">needs eyes</Badge>;
  if (s === "hold_for_review") return <Badge variant="secondary">hold</Badge>;
  if (s === "noise") return <Badge variant="outline">noise</Badge>;
  return <Badge variant="outline">—</Badge>;
}

export default function ShopperPage() {
  const configured = isConfigured();
  const [windowDays, setWindowDays] = useState<FunnelWindow>(7);
  const [d, setD] = useState<Payload | null>(null);
  const [klaviyo, setKlaviyo] = useState<{
    available?: boolean; empty?: boolean; error?: string;
    rows?: Array<{
      window_days: number; flow_name: string; flow_id: string;
      recipients: number | null; conversion_rate: number | null;
      revenue: number | null; unique_clicks: number | null; notes: string | null;
    }>;
    summary?: {
      as_of?: string | null;
      conversion_metric_id?: string;
      windows?: Array<{
        window_days: number; revenue: number | null; unique_clicks_zero: boolean;
      }>;
    };
  } | null>(null);
  const [busy, setBusy] = useState(true);
  const [showDefs, setShowDefs] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 12_000);
    setBusy(true);
    (async () => {
      try {
        const res = await fetch(`/api/shopify-funnel?window=${windowDays}&view=full`, {
          signal: ctrl.signal,
          credentials: "same-origin",
        });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          throw new Error(`Unexpected ${res.status} response.`);
        }
        const payload = await res.json();
        if (!cancelled) setD(payload);
        try {
          const kv = await fetch("/api/klaviyo-abandon", {
            signal: ctrl.signal, credentials: "same-origin",
          });
          if (kv.ok && (kv.headers.get("content-type") ?? "").includes("application/json")) {
            const kpayload = await kv.json();
            if (!cancelled) setKlaviyo(kpayload);
          }
        } catch {
          /* stub card stays empty — do not invent Klaviyo numbers */
        }
      } catch (e) {
        if (cancelled) return;
        const aborted = e instanceof Error && e.name === "AbortError";
        setD({
          available: false,
          error: aborted
            ? "Timed out talking to the warehouse."
            : e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [windowDays, tick]);

  function reload() {
    setTick((n) => n + 1);
  }

  if (!configured) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Server routes need <code className="rounded bg-muted px-1.5 py-0.5 text-xs">SUPABASE_SERVICE_KEY</code>.
        </p>
      </div>
    );
  }

  const maxStep = Math.max(1, ...(d?.steps ?? []).map((s) => s.count ?? 0));
  const scopes = d?.status?.missing_scopes ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Shopper funnel</h1>
          <p className="text-sm text-muted-foreground">
            tallowbourn.com drop-off — Shopify Admin analytics, not GA4.
            {d?.start && d?.end ? ` ${d.start} → ${d.end}.` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {([7, 28] as FunnelWindow[]).map((w) => (
            <Button
              key={w}
              size="sm"
              variant={windowDays === w ? "default" : "outline"}
              onClick={() => setWindowDays(w)}
            >
              Last {w}d
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setShowDefs((v) => !v)}>
            {showDefs ? "Hide definitions" : "Definitions"}
          </Button>
          <Button variant="outline" size="sm" onClick={reload} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      {busy && !d && (
        <div className="space-y-2" aria-busy="true">
          <div className="h-24 animate-pulse rounded-md bg-muted" />
          <div className="h-40 animate-pulse rounded-md bg-muted" />
        </div>
      )}

      {d && !d.available && (
        <Card className="border-amber-500/40">
          <CardContent className="p-4 text-sm">
            <p className="font-medium">could not load</p>
            <p className="mt-1 text-muted-foreground">{d.error}</p>
            {d.setupHint && <p className="mt-2 text-xs">{d.setupHint}</p>}
            <Button className="mt-3" size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {d?.available && d.empty && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Funnel not synced yet. {d.setupHint}
          </CardContent>
        </Card>
      )}

      {scopes.length > 0 && (
        <Card className="border-amber-500/40">
          <CardContent className="p-4 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Shopify denied a query — numbers below are only what the token could read.
            </p>
            <p className="mt-1 text-muted-foreground">
              Dave must grant: {scopes.join(", ")}. We do not fill gaps from GA4 or orders.
            </p>
            {d?.status?.last_error && (
              <p className="mt-2 text-xs text-muted-foreground">{d.status.last_error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {d?.available && !d.empty && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Session → purchase
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(d.conversionRate ?? null)}</p>
                <p className="text-xs text-muted-foreground">
                  {d.funnel?.purchases ?? "—"} of {d.funnel?.sessions ?? "—"} sessions
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Biggest leak
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {d.biggestLeak ? d.biggestLeak.lost.toLocaleString() : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.biggestLeak
                    ? `${d.biggestLeak.fromLabel} → ${d.biggestLeak.toLabel} · ${pct(d.biggestLeak.rate)}`
                    : "Closed-funnel counts missing"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Open abandons
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {d.abandoned ? money(d.abandoned.openValue, 0) : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {d.abandoned?.open ?? "—"} carts
                  {d.abandoned?.recoveryRate != null
                    ? ` · ${pct(d.abandoned.recoveryRate)} recovered`
                    : ""}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Drop-off by step</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(d.steps ?? []).map((s) => (
                <div key={s.key}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span>
                      {s.label}
                      {s.note && (
                        <span className="ml-2 text-[11px] text-muted-foreground">{s.note}</span>
                      )}
                    </span>
                    <span className="tabular-nums font-medium">
                      {s.count == null ? "—" : s.count.toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${s.count == null ? 0 : (s.count / maxStep) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              <div className="divide-y text-sm">
                {(d.dropOff ?? []).map((x) => (
                  <div key={`${x.from}-${x.to}`} className="flex justify-between gap-3 py-1.5">
                    <span className="text-muted-foreground">
                      {x.fromLabel} → {x.toLabel}
                    </span>
                    <span className="tabular-nums">
                      {!x.present
                        ? "—"
                        : x.nested === false
                          ? "not nested"
                          : `${x.lost?.toLocaleString() ?? "—"} · ${pct(x.rate)}`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Top abandoned products</CardTitle>
              </CardHeader>
              <CardContent>
                {!d.abandoned?.topProducts.length ? (
                  <p className="text-sm text-muted-foreground">No open line items in this window.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">$</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.abandoned.topProducts.map((p) => (
                        <TableRow key={p.title + (p.handle ?? "")}>
                          <TableCell>{p.title}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.quantity}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(p.amount, 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Kit vs stick (abandon mix)</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-xs text-muted-foreground">
                  {d.abandoned?.productLeak?.note
                    ?? "Derived from abandoned line items — not a session ATC→checkout."}
                </p>
                {!(d.abandoned?.productLeak?.kinds ?? []).some((k) => k.open || k.recovered) ? (
                  <p className="text-sm text-muted-foreground">No line items in this window.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kind</TableHead>
                        <TableHead className="text-right">Open</TableHead>
                        <TableHead className="text-right">Recovered</TableHead>
                        <TableHead className="text-right">Open $</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.abandoned.productLeak.kinds.map((k) => (
                        <TableRow key={k.kind}>
                          <TableCell className="capitalize">{k.kind}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.open}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.recovered}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(k.openValue, 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Device</CardTitle>
              </CardHeader>
              <CardContent>
                {!d.splits?.device.length ? (
                  <p className="text-sm text-muted-foreground">
                    Device split not stored — ShopifyQL GROUP BY session_device_type was skipped or denied.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Device</TableHead>
                        <TableHead className="text-right">Sessions</TableHead>
                        <TableHead className="text-right">ATC</TableHead>
                        <TableHead className="text-right">Purchase</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.splits.device.map((r) => (
                        <TableRow key={r.device}>
                          <TableCell>{r.device}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.sessions ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.addToCart ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.purchases ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Channel</CardTitle>
              </CardHeader>
              <CardContent>
                {!d.splits?.channel?.length ? (
                  <p className="text-sm text-muted-foreground">
                    Channel split not stored — ShopifyQL GROUP BY referring_channel
                    needs read_reports. We do not invent it from GA4.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Referring channel</TableHead>
                        <TableHead className="text-right">Sessions</TableHead>
                        <TableHead className="text-right">ATC</TableHead>
                        <TableHead className="text-right">Purchase</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.splits.channel.map((r) => (
                        <TableRow key={r.channel}>
                          <TableCell>{r.channel}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.sessions ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.addToCart ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.purchases ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Checkout friction (open carts)</CardTitle>
            </CardHeader>
            <CardContent>
              {!d.abandoned?.friction ? (
                <p className="text-sm text-muted-foreground">Friction fields not stored yet.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3 text-sm">
                  <p>Shipping address started: <span className="tabular-nums font-medium">{d.abandoned.friction.shippingAddressStarted}</span> / {d.abandoned.friction.open}</p>
                  <p>Never started address: <span className="tabular-nums font-medium">{d.abandoned.friction.shippingAddressMissing}</span></p>
                  <p>Discount entered: <span className="tabular-nums font-medium">{d.abandoned.friction.hasDiscount}</span></p>
                  <p className="sm:col-span-3 text-xs text-muted-foreground">
                    Shipping rate unknown on {d.abandoned.friction.shippingRateUnknown} ·
                    payment attempt unknown on {d.abandoned.friction.paymentAttemptUnknown}
                    {" "}— Admin GraphQL AbandonedCheckout does not expose those fields.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Landing pages</CardTitle>
            </CardHeader>
            <CardContent>
              {!d.splits?.landingPage.length ? (
                <p className="text-sm text-muted-foreground">
                  Landing-page split not stored for this window.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Path</TableHead>
                      <TableHead className="text-right">Sessions</TableHead>
                      <TableHead className="text-right">ATC</TableHead>
                      <TableHead className="text-right">Purchase</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.splits.landingPage.map((r) => (
                      <TableRow key={r.path}>
                        <TableCell className="font-mono text-xs">{r.path}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.sessions ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.addToCart ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.purchases ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Abandoned checkouts</CardTitle>
            </CardHeader>
            <CardContent>
              {!d.abandoned?.rows.length ? (
                <p className="text-sm text-muted-foreground">
                  No abandoned checkouts stored for this window
                  {d.status?.abandon_ok === false
                    ? " — token lacks abandoned-checkout access."
                    : "."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Checkout</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead className="text-right">$</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Friction</TableHead>
                      <TableHead>Triage</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.abandoned.rows
                      .slice()
                      .sort((a, b) => b.checkout_date.localeCompare(a.checkout_date))
                      .map((r) => (
                        <TableRow key={r.checkout_id}>
                          <TableCell className="tabular-nums">{r.checkout_date}</TableCell>
                          <TableCell>{r.checkout_name ?? r.checkout_id.slice(-8)}</TableCell>
                          <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                            {(r.line_items ?? [])
                              .map((i) => `${i.quantity ?? 1}× ${i.title ?? "?"}`)
                              .join(", ") || "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(r.total_price, 2)}
                          </TableCell>
                          <TableCell>{r.recovery_status ?? (r.recovered ? "recovered" : "open")}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.shipping_address_started ? "addr" : r.shipping_address_started === false ? "no addr" : "—"}
                            {r.has_discount
                              ? ` · ${r.discount_codes?.length ? r.discount_codes.join(",") : "disc"}`
                              : ""}
                          </TableCell>
                          <TableCell>{severityBadge(r.triage_severity)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {klaviyo?.available && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Klaviyo abandon flows (Kit seed)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">
              Read-only. Conversion metric Placed Order UG4R5c. This app does not write to Klaviyo.
              {klaviyo.summary?.as_of ? ` As of ${klaviyo.summary.as_of}.` : ""}
            </p>
            {klaviyo.empty || !klaviyo.rows?.length ? (
              <p className="text-sm text-muted-foreground">
                No kit-seed rows. Run supabase/migration_shopify_funnel_expand.sql.
              </p>
            ) : (
              <>
                {klaviyo.summary?.windows?.length ? (
                  <div className="mb-3 space-y-1 text-sm">
                    {klaviyo.summary.windows.map((w) => (
                      <p key={w.window_days}>
                        <span className="font-medium">{w.window_days}d combined recovery </span>
                        <span className="tabular-nums">{money(w.revenue, 2)}</span>
                        {w.unique_clicks_zero ? (
                          <Badge variant="outline" className="ml-2 align-middle">
                            unique clicks 0
                          </Badge>
                        ) : null}
                      </p>
                    ))}
                    {klaviyo.summary.windows.some((w) => w.unique_clicks_zero) ? (
                      <p className="text-xs text-muted-foreground">
                        Unique clicks 0 is a flag only — opens still happen.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Window</TableHead>
                      <TableHead>Flow</TableHead>
                      <TableHead className="text-right">Recipients</TableHead>
                      <TableHead className="text-right">Conv</TableHead>
                      <TableHead className="text-right">$</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {klaviyo.rows.map((r) => (
                      <TableRow key={`${r.window_days}-${r.flow_id}`}>
                        <TableCell className="tabular-nums">{r.window_days}d</TableCell>
                        <TableCell>{r.flow_name}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.recipients ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(r.conversion_rate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(r.revenue, 2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.unique_clicks ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {klaviyo.rows.some((r) => r.notes) ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {klaviyo.rows.filter((r) => r.notes).map((r) => (
                      <li key={`${r.window_days}-${r.flow_id}-note`}>{r.notes}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {showDefs && d?.definitions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Definitions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {d.definitions.map(([k, v]) => (
              <p key={k}><span className="font-medium">{k}.</span> {v}</p>
            ))}
          </CardContent>
        </Card>
      )}

      {d?.status?.last_synced_at && (
        <p className="text-xs text-muted-foreground">
          Last Mini sync {d.status.last_synced_at}
          {d.status.funnel_ok === false ? " · funnel query failed" : ""}
          {d.status.abandon_ok === false ? " · abandon query failed" : ""}
        </p>
      )}
    </div>
  );
}
