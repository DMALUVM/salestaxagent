import { GNO_OBSERVE_ONLY } from "@/lib/gno-ppc-watch";
import { exportBannerFromState } from "@/lib/gno-export-state";
import { loadGnoExportState } from "@/lib/gno-store";

/**
 * GET /api/ppc/gno-state — last_export_* + live Wednesday review clock.
 * Fast path so /ppc/gno can render the banner when ads tiles time out.
 * Observe only. Never writes to Amazon.
 */
export async function GET() {
  try {
    const exportState = await loadGnoExportState();
    const exportBanner = exportBannerFromState(exportState);
    return Response.json({
      observeOnly: GNO_OBSERVE_ONLY,
      lastExportAt: exportState?.last_export_at ?? null,
      lastExportReason: exportState?.last_export_reason ?? null,
      nextReviewAt: exportBanner.nextReviewAt,
      upcomingReviewAt: exportBanner.upcomingReviewAt,
      exportBanner,
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
    }, { status: 200 });
  }
}
