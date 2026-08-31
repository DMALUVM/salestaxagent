/** Shared sales-tax filing frequency values for nexus registration. */
export const FILING_FREQUENCIES = [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "casual",
] as const;

export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];

/** Cadences that generate filing_calendar rows. Casual is first-class but has no periodic calendar. */
export const PERIODIC_FILING_FREQUENCIES = [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
] as const;

export const FILING_FREQUENCY_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-Annual",
  annual: "Annual",
  casual: "Casual",
};

export function normalizeFilingFrequency(freq: string | null | undefined): string {
  return (freq ?? "").toLowerCase().replace(/-/g, "_");
}

export function formatFilingFrequency(freq: string | null | undefined): string {
  if (!freq) return "—";
  const key = normalizeFilingFrequency(freq);
  return FILING_FREQUENCY_LABELS[key] ?? freq;
}

export function generatesPeriodicCalendar(freq: string | null | undefined): boolean {
  const key = normalizeFilingFrequency(freq);
  return (PERIODIC_FILING_FREQUENCIES as readonly string[]).includes(key);
}
