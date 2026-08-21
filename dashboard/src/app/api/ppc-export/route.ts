import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * GET /api/ppc-export — the full paste-ready PPC brief.
 *
 * Delegates to the Python builder so the clipboard text and the CLI output are
 * byte-identical. The brief encodes judgement calls (break-even derivation,
 * rank-band policy, scope caveats); a second implementation would drift and the
 * operator would paste something the system does not actually believe.
 */
export async function GET(request: Request) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  const safeDays = /^\d{1,3}$/.test(days) ? days : "7";
  const roots = [path.join(process.cwd(), ".."), process.cwd()];
  let lastErr = "";

  for (const root of roots) {
    try {
      const { stdout } = await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "ppc-export", "--days", safeDays],
        { cwd: root, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return Response.json({ available: true, text: stdout, chars: stdout.length });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return Response.json({
    available: false, text: "", error: lastErr.slice(0, 400),
    hint: "Run `python -m src.main ppc-export` on the agent.",
  });
}
