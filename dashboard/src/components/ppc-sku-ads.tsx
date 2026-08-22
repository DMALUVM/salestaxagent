"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
const AD_TYPE_STYLES: Record<string, string> = {
  SP: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700",
  SB: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  SD: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900",
};

interface SkuRow {
  key: string;
  grain: "sku" | "campaign";
  sku: string | null;
  asin: string | null;
  label: string;
  campaignType: string;
  campaigns: number;
  spend: number;
  adSales: number;
  acos: number | null;
  contribution: number | null;
  contributionAvailable: boolean;
  contributionNote: string;
}

interface SkuAdsData {
  available?: boolean;
  rows?: SkuRow[];
  matchedCampaigns?: number;
  unmatchedCampaigns?: number;
  catalogSize?: number;
  contributionAvailable?: boolean;
  notes?: string[];
  loadErrors?: string[];
  error?: string;
}

function money(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Read-only SKU/ASIN ads vs contribution. Own fetch so a P&L miss cannot
 * take the rest of /ppc down. Contribution stays "unavailable" unless the
 * join is unique and a stored SKU P&L row exists — never invented.
 */
export function PpcSkuAds({ days }: { days: number }) {
  const [data, setData] = useState<SkuAdsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/ppc/sku-ads?days=${days}`)
      .then(async (r) => {
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          throw new Error(`Unexpected ${r.status} response from /api/ppc/sku-ads.`);
        }
        return r.json();
      })
      .then((d: SkuAdsData) => {
        if (cancelled) return;
        if (d.error && !(d.rows && d.rows.length)) {
          setError(d.error);
          setData(d);
        } else {
          setData(d);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load SKU ads.");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [days]);

  return (
    <Card id="ppc-sku-ads" className="scroll-mt-14">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Ads by SKU / ASIN
          <span className="ml-2 font-normal text-muted-foreground">
            {days}d spend · contribution only when the join is unique
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="text-xs text-muted-foreground">Loading SKU / campaign spend…</p>
        )}
        {error && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{error}</p>
        )}
        {!loading && data && (data.loadErrors?.length ?? 0) > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Partial load: {data.loadErrors!.join(" · ")}
          </p>
        )}
        {!loading && data && (data.rows?.length ?? 0) === 0 && !error && (
          <p className="text-xs text-muted-foreground">
            No campaign spend in this window.
          </p>
        )}
        {!loading && data && (data.rows?.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU / campaign</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead className="w-14">Type</TableHead>
                  <TableHead className="text-right">Ad spend</TableHead>
                  <TableHead className="text-right">Ad sales</TableHead>
                  <TableHead className="text-right">ACOS</TableHead>
                  <TableHead className="text-right">Contribution</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows!.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="text-xs">
                      <div className="font-medium truncate max-w-[16rem]" title={r.label}>
                        {r.grain === "sku" ? r.sku : r.label}
                      </div>
                      {r.grain === "sku" && r.label !== r.sku && (
                        <div className="text-[10px] text-muted-foreground truncate max-w-[16rem]">
                          {r.label}
                        </div>
                      )}
                      {r.grain === "campaign" && (
                        <div className="text-[10px] text-muted-foreground">campaign grain</div>
                      )}
                    </TableCell>
                    <TableCell className="text-[10px] text-muted-foreground tabular-nums">
                      {r.asin ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[9px] ${AD_TYPE_STYLES[r.campaignType] ?? ""}`}>
                        {r.campaignType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">${money(r.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">${money(r.adSales)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {r.acos != null ? `${r.acos.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {r.contributionAvailable && r.contribution != null ? (
                        <span className="tabular-nums">${money(r.contribution)}</span>
                      ) : (
                        <span className="text-muted-foreground" title={r.contributionNote}>
                          unavailable
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          {data?.matchedCampaigns ?? 0} campaign{data?.matchedCampaigns === 1 ? "" : "s"} matched
          a sku_costs SKU/ASIN
          {typeof data?.catalogSize === "number" ? ` (${data.catalogSize} in catalog)` : ""}
          {" · "}
          {data?.unmatchedCampaigns ?? 0} shown as campaigns.
          SB/SD have no search-term grain (Amazon limitation).
          Contribution is a stored P&L SKU figure (ads are not allocated at that
          grain) — labelled unavailable rather than invented when the join is
          not unique.
        </p>
      </CardContent>
    </Card>
  );
}
