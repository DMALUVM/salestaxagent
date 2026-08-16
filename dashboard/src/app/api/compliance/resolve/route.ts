import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/compliance/resolve
 *
 * Updates compliance_resolved or compliance_hidden on nexus_status.
 * Body: { state_code, action: "resolve" | "unresolve" | "hide" | "unhide", notes? }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { state_code, action, notes } = body;

  if (!state_code || !action) {
    return Response.json(
      { error: "state_code and action are required" },
      { status: 400 },
    );
  }

  const sb = getServerSupabase();

  const updates: Record<string, unknown> = {};

  if (action === "resolve") {
    updates.compliance_resolved = true;
    updates.compliance_resolved_at = new Date().toISOString();
    if (notes) updates.compliance_notes = notes;
  } else if (action === "unresolve") {
    updates.compliance_resolved = false;
    updates.compliance_resolved_at = null;
  } else if (action === "hide") {
    updates.compliance_hidden = true;
    if (notes) updates.compliance_notes = notes;
  } else if (action === "unhide") {
    updates.compliance_hidden = false;
  } else {
    return Response.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  }

  const { error } = await sb
    .from("nexus_status")
    .update(updates)
    .eq("state_code", state_code);

  if (error) {
    // Columns might not exist yet — tell user what to add
    if (
      error.message.includes("compliance_resolved") ||
      error.message.includes("compliance_hidden")
    ) {
      return Response.json({
        error: "Missing columns. Run this SQL in Supabase Dashboard:",
        sql: `ALTER TABLE nexus_status
  ADD COLUMN IF NOT EXISTS compliance_resolved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_hidden boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_notes text;`,
      }, { status: 500 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, state_code, action });
}
