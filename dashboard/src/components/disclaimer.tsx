import { Info } from "lucide-react";

export function Disclaimer() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        This is a monitoring and research aid, not legal or tax advice. Rules
        change. Consult a qualified CPA before acting on any position.
      </span>
    </div>
  );
}
