import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * GET /api/state-matrix — 50 states + DC, non-sales-tax obligations.
 *
 * Read straight from config/state_entity_matrix.json so the page, the CLI and
 * the file itself cannot drift. `not_researched` is passed through unchanged:
 * the UI must be able to say "not examined", never silently render it as clear.
 */
export async function GET() {
  const candidates = [
    path.join(process.cwd(), "..", "config", "state_entity_matrix.json"),
    path.join(process.cwd(), "config", "state_entity_matrix.json"),
  ];
  for (const p of candidates) {
    try {
      const doc = JSON.parse(await readFile(p, "utf8"));
      const rows = Object.entries(doc.jurisdictions ?? {}).map(
        ([state, r]) => ({ state, ...(r as Record<string, unknown>) }),
      );
      const counts = rows.reduce<Record<string, number>>((acc, r) => {
        const s = String((r as { status?: string }).status ?? "unknown");
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      return Response.json({
        available: true,
        rows,
        counts,
        metadata: doc._metadata ?? null,
      });
    } catch { /* try the next path */ }
  }
  return Response.json({
    available: false, rows: [], counts: {}, metadata: null,
    error: "config/state_entity_matrix.json not found",
  });
}
