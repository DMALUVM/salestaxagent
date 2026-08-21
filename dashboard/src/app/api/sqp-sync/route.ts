import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * POST /api/sqp-sync — run the Brand Analytics SQP pull now.
 *
 * Same shell-out pattern as the registration plan: the SP-API auth, report
 * polling and rank-band logic all live in Python, and a second implementation
 * of the share->band mapping would eventually disagree with the scheduled job.
 *
 * SQP reports can take minutes to generate, so the timeout is generous and the
 * caller is told plainly when it ran out rather than being shown a fake success.
 */
export async function POST() {
  const roots = [path.join(process.cwd(), ".."), process.cwd()];
  let lastErr = "";

  for (const root of roots) {
    try {
      const { stdout } = await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "sqp-sync", "--apply"],
        { cwd: root, timeout: 900_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const text = stdout.trim();
      // The CLI prints the role-permission guidance verbatim when it applies.
      const roleProblem = /Brand Analytics/i.test(text) && /role/i.test(text);
      return Response.json({
        ok: !roleProblem,
        output: text.split("\n").slice(0, 20).join("\n"),
        roleProblem,
      });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  const timedOut = /ETIMEDOUT|timed out/i.test(lastErr);
  return Response.json({
    ok: false,
    error: lastErr.slice(0, 600),
    hint: timedOut
      ? "The SQP report was still generating when the request timed out. It may still complete — check the status card again in a few minutes."
      : "Could not run `python -m src.main sqp-sync --apply`. Check the Brand Analytics role and SP-API credentials.",
  }, { status: 200 });
}
