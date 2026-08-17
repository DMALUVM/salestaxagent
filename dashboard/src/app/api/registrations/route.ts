import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/registrations
 *
 * Update registration fields on nexus_status for a single state.
 * Only touches registration-related columns -- never overwrites
 * engine-computed nexus or progress data.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const state_code = (body.state_code as string ?? "").toUpperCase();
  if (!state_code || state_code.length !== 2) {
    return Response.json(
      { error: "Missing or invalid state_code" },
      { status: 400 },
    );
  }

  const is_registered = body.is_registered === true || body.is_registered === "true";

  const updates: Record<string, unknown> = {
    is_registered,
  };

  // Optional fields -- only set when provided
  if (body.registration_number !== undefined) {
    updates.registration_number = body.registration_number || null;
  }
  if (body.registration_date !== undefined) {
    updates.registration_date = body.registration_date || null;
  }
  if (body.registration_source !== undefined) {
    updates.registration_source = body.registration_source || null;
  }
  if (body.assigned_frequency !== undefined) {
    updates.assigned_frequency = is_registered
      ? body.assigned_frequency || null
      : null;
  }
  if (body.last_filed_through !== undefined) {
    updates.last_filed_through = is_registered
      ? body.last_filed_through || null
      : null;
  }

  // If registering and no registration_date was provided, default to today
  if (is_registered && !updates.registration_date) {
    updates.registration_date = new Date().toISOString().slice(0, 10);
  }

  const sb = getServerSupabase();
  const { error } = await sb
    .from("nexus_status")
    .update(updates)
    .eq("state_code", state_code);

  if (error) {
    return Response.json(
      { error: error.message },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    state_code,
    is_registered,
  });
}
