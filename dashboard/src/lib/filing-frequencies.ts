/** Shared sales-tax filing frequency values for nexus registration. */
export const FILING_FREQUENCIES = [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "casual",
] as const;

export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];

export const FILING_FREQUENCY_LABELS: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-Annual",
  annual: "Annual",
  casual: "Casual",
};

export function formatFilingFrequency(freq: string | null | undefined): string {
  if (!freq) return "—";
  const key = freq.toLowerCase().replace("-", "_");
  return FILING_FREQUENCY_LABELS[key] ?? freq;
}
