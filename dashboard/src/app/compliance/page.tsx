import { Suspense } from "react";
import ComplianceClient from "./ComplianceClient";

export default function CompliancePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading compliance guide…
        </div>
      }
    >
      <ComplianceClient />
    </Suspense>
  );
}
