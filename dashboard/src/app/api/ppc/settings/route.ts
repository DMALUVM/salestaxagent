import type { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  SETTINGS_TABLE, SETTINGS_ROW_ID, loadMergedStrategy, roleTargetsOf,
  validateRoleTargets,
} from "@/lib/ads-strategy-settings";

/**
 * PPC strategy settings — read and write the operator's target overrides.
 *
 * Writes go through this server route so the service-role key stays on the
 * server; the client never gets more Supabase access than it already has.
 *
 * Only `roles.targets` is accepted. Anything else is rejected rather than
 * stored, because a key no reader honours is worse than no key at all.
 */

function knownRoles(order: unknown): string[] {
  return Array.isArray(order) ? order.filter((r): r is string => typeof r === "string") : [];
}

/** GET — merged targets, the file defaults, and whether they are customised. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const s = await loadMergedStrategy(sb);
    return Response.json({
      targets: roleTargetsOf(s.merged),
      defaults: roleTargetsOf(s.defaults),
      roles: knownRoles(s.merged.roles?.order),
      labels: s.merged.roles?.labels ?? {},
      isCustom: s.isCustom,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
      storageAvailable: s.storageAvailable,
      source: s.source,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

/** PUT — save target overrides. Body: { targets: { role: {min,max} | null } }. */
export async function PUT(request: NextRequest) {
  try {
    const sb = getServerSupabase();
    const s = await loadMergedStrategy(sb);

    let body: Record<string, unknown> = {};
    try { body = await request.json(); } catch {
      return Response.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
    }

    const extra = Object.keys(body).filter((k) => k !== "targets");
    if (extra.length) {
      return Response.json({
        ok: false,
        error: `Only "targets" can be saved from the dashboard; received ${extra.join(", ")}`,
      }, { status: 400 });
    }

    const roles = knownRoles(s.merged.roles?.order);
    const { ok, errors, warnings, cleaned } = validateRoleTargets(body.targets, roles);
    if (!ok) {
      return Response.json({ ok: false, error: errors.join("; "), errors }, { status: 400 });
    }

    // Storage checked after validation: a bad band is the caller's error and
    // should be reported as such even when the table has not been created.
    if (!s.storageAvailable) {
      return Response.json({
        ok: false,
        error: "Settings table not found — run supabase/migration_ads_strategy_settings.sql, "
          + "then try again. Targets are still read from config/ads_strategy.json until then.",
      }, { status: 503 });
    }

    // Preserve any other override keys that may exist; only replace targets.
    const nextSettings = {
      ...s.overrides,
      roles: {
        ...(typeof s.overrides.roles === "object" && s.overrides.roles !== null
          ? s.overrides.roles as Record<string, unknown>
          : {}),
        targets: cleaned,
      },
    };

    const { error } = await sb.from(SETTINGS_TABLE).upsert({
      id: SETTINGS_ROW_ID,
      settings: nextSettings,
      updated_at: new Date().toISOString(),
      updated_by: "dashboard",
    }, { onConflict: "id" });
    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    const after = await loadMergedStrategy(sb);
    return Response.json({
      ok: true, warnings,
      targets: roleTargetsOf(after.merged),
      isCustom: after.isCustom,
      updatedAt: after.updatedAt,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** DELETE — drop overrides and fall back to config/ads_strategy.json. */
export async function DELETE() {
  try {
    const sb = getServerSupabase();
    const s = await loadMergedStrategy(sb);
    if (!s.storageAvailable) {
      return Response.json({ ok: true, reset: false, note: "No settings table — already on defaults." });
    }

    const { error } = await sb.from(SETTINGS_TABLE).upsert({
      id: SETTINGS_ROW_ID,
      settings: {},
      updated_at: new Date().toISOString(),
      updated_by: "dashboard:reset",
    }, { onConflict: "id" });
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

    const after = await loadMergedStrategy(sb);
    return Response.json({
      ok: true, reset: true,
      targets: roleTargetsOf(after.merged),
      isCustom: after.isCustom,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
