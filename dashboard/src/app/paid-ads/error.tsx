"use client";

import { useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for /paid-ads.
 * A client exception must not look like an empty Ads Ops feed.
 */
export default function PaidAdsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/paid-ads] render error:", error);
  }, [error]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Paid Ads (Shopify)</h1>
        <p className="text-sm text-muted-foreground">
          Data from Ads Ops structured feed — not a live Ads Manager scrape.
        </p>
      </div>

      <Card className="border-red-200 dark:border-red-900">
        <CardContent className="space-y-3 py-8">
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            The Paid Ads page hit an error while rendering
          </p>
          <p className="text-xs text-muted-foreground">
            This is a fault in the page, not an empty Ads Ops feed.
          </p>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-[10px]">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reset}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={() => location.reload()}>
              Reload page
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
