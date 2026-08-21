import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * GET /api/registration-plan — the ranked sales-tax registration plan.
 *
 * Delegates to the Python engine rather than reimplementing the decision in
 * TypeScript. The prioritisation rules (contested FBA nexus never becomes a
 * silent register_now; a no-sales-tax state can never be a target) are
 * load-bearing, and a second implementation would eventually disagree with the
 * first. The CLI already emits every column as CSV, so this parses that.
 */
function repoRoots(): string[] {
  return [path.join(process.cwd(), ".."), process.cwd()];
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === "," && !quoted) { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

export async function GET() {
  const tmp = path.join("/tmp", `registration-plan-${process.pid}.csv`);
  for (const root of repoRoots()) {
    try {
      await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "registration-plan", "--csv", tmp],
        { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const { readFile, unlink } = await import("node:fs/promises");
      const csv = await readFile(tmp, "utf8");
      await unlink(tmp).catch(() => {});
      const rows = parseCsv(csv);
      const counts = rows.reduce<Record<string, number>>((acc, r) => {
        const a = r.recommended_action || "unknown";
        acc[a] = (acc[a] ?? 0) + 1;
        return acc;
      }, {});
      return Response.json({ available: true, rows, counts });
    } catch (e) {
      // Try the next root; report only if every candidate fails.
      if (root === repoRoots()[repoRoots().length - 1]) {
        return Response.json({
          available: false, rows: [], counts: {},
          error: e instanceof Error ? e.message.slice(0, 400) : "unknown error",
          hint: "Could not run `python -m src.main registration-plan`. Run it in a terminal to see the plan.",
        });
      }
    }
  }
  return Response.json({ available: false, rows: [], counts: {}, error: "unreachable" });
}
