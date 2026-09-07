"use client";

import { PpcGnoWatch } from "@/components/ppc-gno-watch";
import { isConfigured } from "@/lib/supabase";
import { Shield } from "lucide-react";

/**
 * Adjacent GNO PPC Watch desk. Recovery / Bleeders stay on /ppc.
 * Observe + export + alert only — never pause or negate from here.
 */
export default function GnoPpcWatchPage() {
  if (!isConfigured()) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Shield className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <h2 className="text-lg font-semibold">Connect to Supabase</h2>
      </div>
    );
  }
  return <PpcGnoWatch />;
}
