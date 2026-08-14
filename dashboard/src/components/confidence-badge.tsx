import { Badge } from "@/components/ui/badge";

const styles: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  medium: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  low: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-700",
  contested: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
};

export function ConfidenceBadge({ level }: { level: string | null }) {
  const l = (level ?? "medium").toLowerCase();
  return (
    <Badge variant="outline" className={`text-xs font-medium ${styles[l] ?? styles.medium}`}>
      {l === "contested" ? "Contested" : l.charAt(0).toUpperCase() + l.slice(1)}
    </Badge>
  );
}
