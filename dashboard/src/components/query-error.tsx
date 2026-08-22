import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Explicit failure state. A spinner that never resolves and a silent "0"
 * both hide the fact that a query failed — this names the fault and offers
 * a retry so the operator does not treat a load error as empty data.
 */
export function QueryError({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <AlertTriangle className="mb-3 h-8 w-8 text-amber-500" />
      <h2 className="text-sm font-semibold">Couldn&apos;t load this view</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {message || "The request failed. This is a load error, not empty data."}
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
