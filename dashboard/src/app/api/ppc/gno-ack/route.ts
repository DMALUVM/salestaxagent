import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { GNO_OBSERVE_ONLY } from "@/lib/gno-ppc-watch";
import { gnoAlertKey } from "@/lib/gno-alert-done";

/**
 * POST /api/ppc/gno-ack — Done checkoff for GNO Watch alerts.
 * Observe only. Never writes to Amazon.
 *
 * Body: { key?, code, campaign_name?, search_term?, priority?, done: boolean }
 * Persists to gno_alert_acks when the table exists; otherwise returns
 * persisted:false so the desk still keeps the checkoff in localStorage.
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      key?: string;
      code?: string;
      campaign_name?: string;
      search_term?: string;
      priority?: string;
      done?: boolean;
    };
    const code = String(body.code ?? "").trim();
    const key = String(body.key ?? (code
      ? gnoAlertKey({
          code,
          campaign_name: body.campaign_name,
          search_term: body.search_term,
        })
      : "")).trim();
    if (!key) {
      return Response.json({ ok: false, error: "alert key required" }, { status: 400 });
    }
    const done = body.done !== false;
    const now = new Date().toISOString();
    try {
      const sb = getServerSupabase();
      const { error } = await sb.from("gno_alert_acks").upsert({
        alert_key: key,
        code: code || key.split("\t")[0],
        campaign_name: body.campaign_name ?? null,
        search_term: body.search_term ?? null,
        priority: body.priority ?? null,
        status: done ? "done" : "open",
        done_at: done ? now : null,
        updated_at: now,
      }, { onConflict: "alert_key" });
      if (error) {
        return Response.json({
          ok: true,
          persisted: false,
          observeOnly: GNO_OBSERVE_ONLY,
          error: error.message,
          hint: "Run supabase/migration_gno_alert_acks.sql to persist Done across devices.",
        });
      }
      return Response.json({
        ok: true,
        persisted: true,
        observeOnly: GNO_OBSERVE_ONLY,
        key,
        status: done ? "done" : "open",
      });
    } catch (e) {
      return Response.json({
        ok: true,
        persisted: false,
        observeOnly: GNO_OBSERVE_ONLY,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } catch (e) {
    return Response.json({
      ok: false,
      observeOnly: true,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
