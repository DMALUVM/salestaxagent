import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * GET /api/ppc-playbook — ordered decisions for this week.
 *
 * Delegates to the Python playbook rather than re-deriving the thresholds in
 * TypeScript. The ordering (waste before growth) and the brand-vs-rank
 * distinction are judgement calls; a second implementation would drift from the
 * one the CLI prints, and the two would quietly disagree in a meeting.
 */
export async function GET() {
  const roots = [path.join(process.cwd(), ".."), process.cwd()];
  let lastErr = "";
  for (const root of roots) {
    try {
      const { stdout } = await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "ppc-playbook"],
        { cwd: root, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return Response.json({ available: true, text: stdout.trim() });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return Response.json({
    available: false, text: "",
    error: lastErr.slice(0, 400),
    hint: "Run `python -m src.main ppc-playbook` on the agent.",
  });
}
