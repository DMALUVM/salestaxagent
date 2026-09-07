import { NextRequest } from "next/server";
import { amazonAsOf } from "@/lib/as-of";
import { insertGnoLedger } from "@/lib/gno-store";
import {
  isDaveAction,
  parseGnoOutcomeLines,
  type DaveAction,
} from "@/lib/gno-learning";

/**
 * POST /api/ppc/gno-outcome — log a Dave/Grok outcome.
 * Observe only. Never pauses, negates, or writes bids to Amazon.
 */

interface Body {
  paste?: string;
  entries?: Array<{
    dave_action?: string;
    campaign_name?: string;
    search_term?: string;
    proposed_tag?: string;
    pack_date?: string;
    notes?: string;
  }>;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Body;
    const packDate = amazonAsOf();
    const fromPaste = body.paste ? parseGnoOutcomeLines(body.paste) : [];
    const fromEntries = (body.entries ?? [])
      .filter((e) => e.dave_action && isDaveAction(e.dave_action))
      .map((e) => ({
        dave_action: e.dave_action as DaveAction,
        campaign_name: e.campaign_name ?? null,
        search_term: e.search_term ?? null,
        proposed_tag: e.proposed_tag ?? null,
        pack_date: e.pack_date ?? packDate,
        source: "ui" as const,
        notes: e.notes ?? null,
      }));
    const entries = [
      ...fromPaste.map((p) => ({
        dave_action: p.dave_action,
        campaign_name: p.campaign_name ?? null,
        search_term: p.search_term ?? null,
        proposed_tag: p.proposed_tag ?? null,
        pack_date: packDate,
        source: "paste" as const,
        notes: null as string | null,
      })),
      ...fromEntries,
    ];
    if (!entries.length) {
      return Response.json({
        ok: false,
        written: 0,
        error: "No outcomes to log. Try `tallow lip balm organic skip` or a row action.",
      }, { status: 400 });
    }
    const result = await insertGnoLedger(entries);
    if (!result.ok) {
      return Response.json({
        ok: false,
        written: 0,
        error: result.error ?? "Could not store outcomes.",
        hint: result.hint ?? "Nothing wrote to Amazon.",
      }, { status: 503 });
    }
    return Response.json({
      ok: true,
      written: result.written,
      observeOnly: true,
      hint: "Logged for learning only. Nothing wrote to Amazon. One change per campaign per day still Dave/Grok.",
    });
  } catch (e) {
    return Response.json({
      ok: false,
      written: 0,
      error: e instanceof Error ? e.message : String(e),
      hint: "Observe only — this route never writes to Amazon.",
    }, { status: 500 });
  }
}
