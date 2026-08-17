import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/registrations
 *
 * Save registration fields to nexus_status using service-role key.
 * Body: { state_code, is_registered, registration_number?, registration_date?,
 *         registration_source?, assigned_frequency?, last_filed_through? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sb = getServerSupabase();

    const { state_code, ...fields } = body;
    if (!state_code) {
      return Response.json({ error: "state_code required" }, { status: 400 });
    }

    const update: Record<string, unknown> = {};

    // Always set is_registered
    if ("is_registered" in fields) {
      update.is_registered = fields.is_registered === true;
    }

    // Registration fields (only when registering)
    if (update.is_registered) {
      update.registration_date = fields.registration_date || new Date().toISOString().slice(0, 10);
      update.registration_number = fields.registration_number || null;
      update.registration_source = fields.registration_source || null;
      update.assigned_frequency = fields.assigned_frequency || null;
      update.last_filed_through = fields.last_filed_through || null;
    } else {
      // Unregistering: clear registration fields
      update.registration_date = null;
      update.registration_number = null;
      update.registration_source = null;
      update.assigned_frequency = null;
      update.last_filed_through = null;
    }

    const { data, error } = await sb
      .from("nexus_status")
      .update(update)
      .eq("state_code", state_code)
      .select("state_code, is_registered")
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, state_code, is_registered: data?.is_registered });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
