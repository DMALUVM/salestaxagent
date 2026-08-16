import { Suspense } from "react";
import ComplianceHub from "./ComplianceHub";

export default function CompliancePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          Loading compliance hub...
        </div>
      }
    >
      <ComplianceHub />
    </Suspense>
  );
}
