/**
 * Tax / physical-nexus inventory $ at sku_costs (COGS).
 * Peak YTD is the maximum daily state total, not the latest snapshot.
 */

export const UNKNOWN_STATE = "XX";
export const AWD_NATIONAL = "AWD";

export interface LedgerDailyRow {
  snapshot_date: string;
  sku: string;
  fc_code: string;
  state_code: string | null;
  disposition: string;
  ending_qty: number;
  cogs_per_unit: number | null;
  cogs_value: number;
}

export interface StatePeak {
  state_code: string;
  peak_cogs: number;
  peak_date: string;
  current_cogs: number;
  current_units: number;
  current_fc_count: number;
  fba_cogs: number;
  awd_cogs: number;
}

export interface TaxInventoryPayload {
  year: number;
  latest_snapshot: string | null;
  states: StatePeak[];
  awd: {
    cogs: number;
    units: number;
    note: string;
  };
  unknown_fcs: string[];
  missing_cost: {
    sku_count: number;
    units: number;
  };
}

export const AWD_NATIONAL_NOTE =
  "AWD is national-only — the AWD API does not return warehouse or state, so it is not assigned to a US state.";

export function stateKey(stateCode: string | null | undefined): string {
  const sc = (stateCode ?? "").trim().toUpperCase();
  return sc || UNKNOWN_STATE;
}

/** Peak YTD + current (latest day) from daily ledger rows. */
export function peakByState(rows: LedgerDailyRow[], year: number): StatePeak[] {
  const daily = new Map<
    string,
    { cogs: number; units: number; fcs: Set<string> }
  >();

  for (const r of rows) {
    const day = (r.snapshot_date ?? "").slice(0, 10);
    if (!day.startsWith(String(year))) continue;
    const state = stateKey(r.state_code);
    const key = `${state}|${day}`;
    const bucket = daily.get(key) ?? {
      cogs: 0,
      units: 0,
      fcs: new Set<string>(),
    };
    bucket.cogs += Number(r.cogs_value) || 0;
    bucket.units += Number(r.ending_qty) || 0;
    if (r.fc_code) bucket.fcs.add(r.fc_code);
    daily.set(key, bucket);
  }

  if (daily.size === 0) return [];

  let latest = "";
  for (const key of daily.keys()) {
    const day = key.split("|")[1];
    if (day > latest) latest = day;
  }

  const peaks = new Map<string, StatePeak>();
  for (const [key, bucket] of daily) {
    const [state, day] = key.split("|");
    const cogs = round2(bucket.cogs);
    const cur = peaks.get(state);
    if (
      !cur ||
      cogs > cur.peak_cogs ||
      (cogs === cur.peak_cogs && day > cur.peak_date)
    ) {
      peaks.set(state, {
        state_code: state,
        peak_cogs: cogs,
        peak_date: day,
        current_cogs: 0,
        current_units: 0,
        current_fc_count: 0,
        fba_cogs: 0,
        awd_cogs: 0,
      });
    }
  }

  for (const [key, bucket] of daily) {
    const [state, day] = key.split("|");
    if (day !== latest) continue;
    const row = peaks.get(state);
    if (!row) continue;
    row.current_cogs = round2(bucket.cogs);
    row.current_units = bucket.units;
    row.current_fc_count = bucket.fcs.size;
    row.fba_cogs = row.current_cogs;
  }

  return Array.from(peaks.values()).sort((a, b) => b.peak_cogs - a.peak_cogs);
}

export function attachAwdNational(
  states: StatePeak[],
  awdCogs: number,
  awdUnits: number,
): StatePeak[] {
  const out = states.map((s) => ({ ...s, awd_cogs: 0 }));
  if (awdCogs <= 0 && awdUnits <= 0) return out;
  out.push({
    state_code: AWD_NATIONAL,
    peak_cogs: 0,
    peak_date: "",
    current_cogs: round2(awdCogs),
    current_units: awdUnits,
    current_fc_count: 0,
    fba_cogs: 0,
    awd_cogs: round2(awdCogs),
  });
  return out;
}

export function toCsv(states: StatePeak[]): string {
  const header = [
    "state",
    "max_cogs",
    "date_of_max",
    "current_on_hand_cogs",
    "fba_cogs",
    "awd_cogs",
    "unit_count",
  ];
  const lines = [header.join(",")];
  for (const s of states) {
    const label =
      s.state_code === UNKNOWN_STATE
        ? "Unknown"
        : s.state_code === AWD_NATIONAL
          ? "AWD (national)"
          : s.state_code;
    lines.push(
      [
        label,
        s.peak_cogs.toFixed(2),
        s.peak_date,
        s.current_cogs.toFixed(2),
        s.fba_cogs.toFixed(2),
        s.awd_cogs.toFixed(2),
        String(s.current_units),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
