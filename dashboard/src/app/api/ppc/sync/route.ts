import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * POST /api/ppc/sync — Trigger ads-sync via CLI.
 * Same job as `python -m src.main ads-sync --days N`.
 * Chunked ≤31d, search terms 90min timeout + retry.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 90);

    // Run ads-sync in project root (non-blocking — fire and respond)
    const projectRoot = process.cwd().replace(/\/dashboard$/, "");
    const cmd = `cd "${projectRoot}" && python3 -m src.main ads-sync --days ${days}`;

    // Run with a generous timeout but don't block the HTTP response forever
    // The sync can take 30+ minutes for search terms, so we fire-and-forget
    execAsync(cmd, { timeout: 7200_000 }).catch((err) => {
      console.error("ads-sync background error:", err.message?.slice(0, 200));
    });

    return Response.json({ ok: true, message: `ads-sync --days ${days} started` });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
