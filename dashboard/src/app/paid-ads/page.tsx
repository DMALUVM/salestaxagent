"use client";

import { useState } from "react";
import { LoadingState } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { PaidAdsIntel, usePaidIntel } from "@/components/paid-ads-intel";
import { isConfigured } from "@/lib/supabase";
import type { IntelFilter, IntelRangeDays } from "@/lib/paid-intel/types";
import { Shield } from "lucide-react";

export default function PaidAdsPage() {
  const [range, setRange] = useState<IntelRangeDays>(7);
  const [filter, setFilter] = useState<IntelFilter>("all");
  const { data, loading, error, reload } = usePaidIntel(range, filter);

  if (!isConfigured()) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Set <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
          {" "}(plus <code className="rounded bg-muted px-1.5 py-0.5 text-xs">SUPABASE_SERVICE_KEY</code> on the server)
          so this page can read the paid intel on Dashboard.
        </p>
      </div>
    );
  }

  if (loading && !data) return <LoadingState />;
  if (error && !data) return <QueryError message={error} onRetry={reload} />;
  if (!data) return <LoadingState />;

  return (
    <PaidAdsIntel
      data={data}
      range={range}
      filter={filter}
      onRange={setRange}
      onFilter={setFilter}
      onUploaded={reload}
      loadWarning={error}
    />
  );
}
