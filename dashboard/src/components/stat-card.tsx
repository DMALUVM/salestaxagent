import { Card, CardContent } from "@/components/ui/card";
import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  accent?: "default" | "red" | "amber" | "green" | "blue";
}

const accentBorder: Record<string, string> = {
  default: "border-l-slate-300 dark:border-l-slate-600",
  red: "border-l-red-400 dark:border-l-red-500",
  amber: "border-l-amber-400 dark:border-l-amber-500",
  green: "border-l-emerald-400 dark:border-l-emerald-500",
  blue: "border-l-blue-400 dark:border-l-blue-500",
};

export function StatCard({ title, value, subtitle, icon, accent = "default" }: StatCardProps) {
  return (
    <Card className={`border-l-4 ${accentBorder[accent]}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-2xl font-semibold tracking-tight">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {icon && (
            <div className="text-muted-foreground/60">{icon}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
