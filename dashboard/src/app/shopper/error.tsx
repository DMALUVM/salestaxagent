"use client";

import { useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function ShopperError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/shopper] render error:", error);
  }, [error]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Shopper funnel</h1>
        <p className="text-sm text-muted-foreground">
          tallowbourn.com drop-off — Shopify Admin analytics, not GA4.
        </p>
      </div>
      <Card className="border-red-200 dark:border-red-900">
        <CardContent className="space-y-3 py-8">
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            The shopper page hit an error while rendering
          </p>
          <p className="text-xs text-muted-foreground">
            This is a fault in the page, not an empty funnel.
          </p>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-[10px]">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reset}>Try again</Button>
            <Button variant="ghost" size="sm" onClick={() => location.reload()}>
              Reload page
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
