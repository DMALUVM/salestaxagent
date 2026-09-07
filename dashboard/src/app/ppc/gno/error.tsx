"use client";

import { useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function GnoPpcError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[/ppc/gno] render error:", error);
  }, [error]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">GNO PPC Watch</h1>
      <Card className="border-red-200 dark:border-red-900">
        <CardContent className="space-y-3 py-8">
          <p className="text-sm font-medium text-red-700 dark:text-red-300">
            GNO Watch hit an error while rendering
          </p>
          <p className="text-xs text-muted-foreground">
            Recovery / This week on /ppc is unaffected. This desk is observe-only.
          </p>
          <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-[10px]">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reset}>Try again</Button>
            <Link href="/ppc" className="inline-flex h-7 items-center px-2.5 text-[0.8rem] hover:underline">
              Back to Amazon PPC
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
