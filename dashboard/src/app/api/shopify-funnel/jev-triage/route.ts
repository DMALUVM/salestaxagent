import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  ensureFunnelJevTriage,
  evaluateViaGateway,
  hasGatewayKey,
  holdClosed,
  type JevResult,
} from "@/lib/funnel-jev-triage";

/**
 * GET/POST /api/shopify-funnel/jev-triage
 *
 * Vercel runtime for Jev leak triage. Reads Mini-written
 * shopify_funnel_status.last_stats (leak + abandon). Writes last_stats.jev.
 * Never calls Shopify. Never writes theme / storefront.
 *
 * Auth: dashboard Basic Auth (manual) or Bearer $CRON_SECRET (Vercel cron).
 * Fail closed → hold_for_review when AI_GATEWAY_API_KEY is absent.
 * Silent last_stats → no LLM.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

async function handle(request: NextRequest): Promise<Response> {
  try {
    const url = request.nextUrl;
    const force = url.searchParams.get("force") === "1";
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("shopify_funnel_status")
      .select("id,last_stats,updated_at")
      .eq("id", 1)
      .limit(1)
      .maybeSingle();

    if (error) {
      return Response.json({
        ...holdClosed("status_unreadable"),
        error: error.message.slice(0, 200),
      });
    }

    const stats = isRecord(data?.last_stats) ? data.last_stats : null;
    const keyed = hasGatewayKey();
    const result: JevResult = await ensureFunnelJevTriage({
      stats,
      hasGatewayKey: keyed,
      force,
      evaluate: keyed ? evaluateViaGateway : undefined,
      persist: data?.id === 1 && stats
        ? async (merged) => {
          const { error: writeErr } = await sb
            .from("shopify_funnel_status")
            .update({
              last_stats: merged,
              updated_at: new Date().toISOString(),
            })
            .eq("id", 1);
          if (writeErr) {
            throw new Error(writeErr.message);
          }
        }
        : undefined,
    });

    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const key = (process.env.AI_GATEWAY_API_KEY ?? "").trim();
    const safe = key && msg.includes(key) ? msg.split(key).join("[REDACTED]") : msg;
    return Response.json(holdClosed("jev_failed", { error: safe.slice(0, 200) }));
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
