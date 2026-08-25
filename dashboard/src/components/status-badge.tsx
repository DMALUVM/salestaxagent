import { Badge } from "@/components/ui/badge";
import { formatFilingFrequency } from "@/lib/filing-frequencies";

const nexusStyles: Record<string, string> = {
  active: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  approaching: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  safe: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  registered: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
};

export function NexusBadge({ active, label }: { active: boolean; label?: string }) {
  if (active) {
    return (
      <Badge variant="outline" className={`text-xs font-medium ${nexusStyles.active}`}>
        {label ?? "Yes"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs font-medium text-muted-foreground">
      {label ?? "No"}
    </Badge>
  );
}

const filingStyles: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  filed: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  late: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  overdue: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
};

export function FilingStatusBadge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "pending").toLowerCase();
  return (
    <Badge variant="outline" className={`text-xs font-medium ${filingStyles[s] ?? filingStyles.pending}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </Badge>
  );
}

const severityStyles: Record<string, string> = {
  critical: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  warning: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  info: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
};

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const s = (severity ?? "info").toLowerCase();
  return (
    <Badge variant="outline" className={`text-xs font-medium ${severityStyles[s] ?? severityStyles.info}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </Badge>
  );
}

const frequencyStyles: Record<string, string> = {
  monthly: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-800",
  quarterly: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-800",
  casual: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  annual: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700",
};

export function FrequencyBadge({ frequency }: { frequency: string | null | undefined }) {
  if (!frequency) {
    return (
      <Badge variant="outline" className="text-xs font-medium text-muted-foreground">
        —
      </Badge>
    );
  }
  const key = frequency.toLowerCase().replace("-", "_");
  const label = formatFilingFrequency(key);
  return (
    <Badge variant="outline" className={`text-xs font-medium ${frequencyStyles[key] ?? frequencyStyles.monthly}`}>
      {label}
    </Badge>
  );
}
