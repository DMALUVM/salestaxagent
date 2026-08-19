import { PlanningHub, type PlanningTab } from "@/components/inventory/PlanningHub";

/**
 * /planning — single nav destination for the Demand and Inbound planners.
 *
 * The old /forecast and /planner routes redirect here with ?tab= (see
 * next.config.ts). Reading searchParams on the server keeps the client hub free
 * of useSearchParams, so no Suspense boundary is needed.
 */
export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  const initialTab: PlanningTab = tab === "inbound" ? "inbound" : "demand";

  return <PlanningHub initialTab={initialTab} />;
}
