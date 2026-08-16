/**
 * Shared compliance status model.
 *
 * IMPORTANT: Every consumer of is_registered must use isRegistered()
 * below, not a raw === true check. Supabase may return boolean, string,
 * number, or null depending on schema / RLS / migration state.
 *
 * queue_bucket rules:
 *  - needs_registration: nexus (economic exceeded OR physical assertable)
 *                        AND NOT is_registered AND NOT compliance_hidden
 *  - approaching:        economic approaching threshold AND NOT is_registered
 *  - registered_monitor: is_registered (filing/calendar matters; registration CTA does not)
 *  - resolved:           compliance_resolved = true
 *  - watch_only:         contested/carve-out posture without registration push, or hidden
 */

/**
 * Canonical registration check. Use this instead of raw `=== true`.
 * Handles: true, "true", 1, "1" → true; everything else → false.
 */
export function isRegistered(val: unknown): boolean {
  return val === true || val === "true" || val === 1 || val === "1";
}

export type QueueBucket =
  | "needs_registration"
  | "approaching"
  | "registered_monitor"
  | "resolved"
  | "watch_only";

export interface ComplianceState {
  state_code: string;
  has_physical_nexus: boolean;
  has_economic_nexus: boolean;
  economic_pct: number;
  is_registered: boolean;
  compliance_resolved: boolean;
  compliance_hidden: boolean;
  confidence: string;
  queue_bucket: QueueBucket;
}

const WARN_PCT = 80;

export function getQueueBucket(row: {
  has_physical_nexus?: boolean;
  has_economic_nexus?: boolean;
  economic_progress_percent?: number | null;
  is_registered?: boolean;
  compliance_resolved?: boolean;
  compliance_hidden?: boolean;
  confidence?: string | null;
}): QueueBucket {
  const resolved = !!row.compliance_resolved;
  if (resolved) return "resolved";

  const registered = isRegistered(row.is_registered);
  if (registered) return "registered_monitor";

  const hidden = !!row.compliance_hidden;
  if (hidden) return "watch_only";

  const hasNexus = !!row.has_physical_nexus || !!row.has_economic_nexus;
  const econPct = row.economic_progress_percent ?? 0;
  const approaching = econPct >= WARN_PCT && !row.has_economic_nexus;

  if (hasNexus) return "needs_registration";
  if (approaching) return "approaching";

  return "watch_only";
}

/**
 * Count states that need registration action (for nav badges).
 * Only nexus-detected + not registered + not resolved + not hidden.
 */
export function countNeedsRegistration(
  rows: Array<{
    has_physical_nexus?: boolean;
    has_economic_nexus?: boolean;
    is_registered?: boolean;
    compliance_resolved?: boolean;
    compliance_hidden?: boolean;
  }>,
): number {
  return rows.filter(
    (r) =>
      (r.has_physical_nexus || r.has_economic_nexus) &&
      !isRegistered(r.is_registered) &&
      !r.compliance_resolved &&
      !r.compliance_hidden,
  ).length;
}
