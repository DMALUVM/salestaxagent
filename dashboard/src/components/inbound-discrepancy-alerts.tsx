"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  HOW_TO_FILE_INBOUND,
  NEEDS_CASE_HREF,
  apiUrl,
  caseQty,
  fbaShipmentId,
  inboundReceived,
  inboundShipped,
  sellerCentralHref,
  sourceLabel,
  type CaseEventRow,
} from "@/lib/reimbursements-eligible";

interface AlertsPayload {
  asOf?: string;
  href?: string;
  howTo?: string;
  alerts?: CaseEventRow[];
  tableMissing?: boolean;
}

export function InboundDiscrepancyAlerts() {
  const [alerts, setAlerts] = useState<CaseEventRow[]>([]);
  const [href, setHref] = useState(NEEDS_CASE_HREF);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(apiUrl("/api/reimbursements/inbound-alerts"))
      .then((r) => r.json())
      .then((d: AlertsPayload) => {
        setAlerts(Array.isArray(d.alerts) ? d.alerts : []);
        if (d.href) setHref(d.href);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function dismiss(row: CaseEventRow) {
    setBusyKey(row.event_key);
    setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/reimbursements/inbound-alerts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_key: row.event_key, note: "filed" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Dismiss failed");
      setAlerts((prev) => prev.filter((a) => a.event_key !== row.event_key));
      setMsg("Marked submitted — kept on Needs case history. No Amazon write.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  if (loading || alerts.length === 0) return null;

  return (
    <Card className="border-amber-400/70 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-amber-950 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Lost inbound / inbound discrepancy
          <span className="tabular-nums text-xs font-normal text-amber-800/80 dark:text-amber-200/80">
            {alerts.length} open
          </span>
        </CardTitle>
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          CLOSED (or stale RECEIVING) shipped − received shorts.{" "}
          <Link href={href} className="font-medium underline underline-offset-2">
            Open Needs case
          </Link>
          . WORKING / IN_TRANSIT do not alert.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {alerts.map((row) => {
          const sid = fbaShipmentId(row.shipment_id);
          const shipped = inboundShipped(row);
          const received = inboundReceived(row);
          const tracker = sid ? sellerCentralHref(row) : null;
          return (
            <div
              key={row.event_key}
              className="flex flex-col gap-2 rounded-md border border-amber-300/70 bg-background/70 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between dark:border-amber-800"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  <span className="font-mono">{sid || "—"}</span>
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {row.sku || "—"}
                    {row.asin ? ` · ${row.asin}` : ""}
                    {row.fulfillment_center ? ` · ${row.fulfillment_center}` : ""}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Short {caseQty(row)}
                  {shipped != null && received != null ? ` · ${shipped}→${received}` : ""}
                  {" · "}
                  {sourceLabel(row.source)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {tracker && (
                  <a
                    href={tracker}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Shipment events
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <Link href={href} className="text-xs font-medium text-primary hover:underline">
                  Needs case
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyKey === row.event_key}
                  onClick={() => dismiss(row)}
                  title="Mark submitted after you file in Seller Central. Evidence stays in history."
                >
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {busyKey === row.event_key ? "Saving…" : "Dismiss"}
                </Button>
              </div>
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">{HOW_TO_FILE_INBOUND}</p>
        {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
