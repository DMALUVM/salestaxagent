import { connectorStatus, PHASE2_CONNECTORS } from "@/lib/phase2-env";
import { hasAiGatewayKey, JEV_SIBLING } from "@/lib/jev-funnel";

/**
 * GET /api/phase2-status
 *
 * Boolean configured flags only. Never echoes secret values.
 * Dave/Dana use this after pasting Vercel env names.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const connectors = Object.fromEntries(
    (Object.keys(PHASE2_CONNECTORS) as Array<keyof typeof PHASE2_CONNECTORS>)
      .map((name) => [name, connectorStatus(name)]),
  );
  return Response.json({
    vercelProject: "dashboard",
    secretsOn: "Vercel",
    connectors,
    jev: {
      aiGatewayKey: hasAiGatewayKey(),
      sibling: JEV_SIBLING,
      evaluateWired: false,
    },
  });
}
