import { GNO_OBSERVE_ONLY } from "@/lib/gno-ppc-watch";
import { exportBannerFromState } from "@/lib/gno-export-state";
import { GNO_LEDGER_RECENT_LIMIT, ledgerRecent } from "@/lib/gno-methodology";
import { loadGnoExportState, loadGnoLedger } from "@/lib/gno-store";

/**
 * GET /api/ppc/gno-state — last_export_* + live Wednesday review clock.
 * Fast path so /ppc/gno can render the banner when ads tiles time out.
 * Observe only. Never writes to Amazon.
 */
export async function GET() {
  try {
    const [exportState, ledger] = await Promise.all([
      loadGnoExportState(),
      loadGnoLedger(),
    ]);
    const exportBanner = exportBannerFromState(exportState);
    return Response.json({
      observeOnly: GNO_OBSERVE_ONLY,
      lastExportAt: exportState?.last_export_at ?? null,
      lastExportReason: exportState?.last_export_reason ?? null,
      nextReviewAt: exportBanner.nextReviewAt,
      upcomingReviewAt: exportBanner.upcomingReviewAt,
      exportBanner,
      ledgerRecent: ledgerRecent(ledger, GNO_LEDGER_RECENT_LIMIT),
    });
  } catch (e) {
    const exportBanner = exportBannerFromState(null);
    return Response.json({
      observeOnly: true,
      error: e instanceof Error ? e.message : String(e),
      lastExportAt: null,
      lastExportReason: null,
      nextReviewAt: exportBanner.nextReviewAt,
      upcomingReviewAt: exportBanner.upcomingReviewAt,
      exportBanner,
      ledgerRecent: [],
    }, { status: 200 });
  }
}
