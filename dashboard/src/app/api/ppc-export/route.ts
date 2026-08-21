import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getServerSupabase } from "@/lib/supabase-server";

const run = promisify(execFile);

/**
 * GET /api/ppc-export — the full paste-ready PPC Command Brief.
 *
 * Two paths, in order:
 *
 *  1. **Live** — shell to the Python builder. This is the only implementation
 *     of the brief and of the grading formula, so a live build is always
 *     current and always agrees with `python -m src.main ppc-export`.
 *
 *  2. **Published** — read the newest row from `ppc_briefs`, written by
 *     `ppc-export --publish` on the agent. Vercel has no interpreter, so
 *     without this the button could only ever fail there.
 *
 * The alternative — reimplementing the builder in TypeScript so it runs on
 * Vercel — was rejected deliberately. The brief carries a 0-100 grade computed
 * from weighted components; two implementations of that arithmetic drift, and
 * the failure mode is the CLI and the dashboard handing the operator two
 * different grades for the same week with no way to tell which is right. One
 * implementation plus an honestly-stamped cache is worth more than two live
 * ones that disagree.
 *
 * Never called during /ppc render — this route is button-only. See
 * src/lib/render-safety.test.ts.
 */
export const dynamic = "force-dynamic";

async function fromPython(days: string) {
  const roots = [path.join(process.cwd(), ".."), process.cwd()];
  let lastErr = "";
  for (const root of roots) {
    try {
      const { stdout } = await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "ppc-export", "--days", days],
        { cwd: root, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      );
      if (stdout.trim()) return { text: stdout, error: "" };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { text: "", error: lastErr || "python produced no output" };
}

async function fromPublished(days: number) {
  const sb = getServerSupabase();
  const r = await sb
    .from("ppc_briefs")
    .select("prompt_md,chars,generated_at,as_of,score,letter,formula_version")
    .eq("days", days)
    .order("generated_at", { ascending: false })
    .limit(1);
  if (r.error) throw new Error(r.error.message);
  return r.data?.[0] ?? null;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("days") ?? "7";
  const safeDays = /^\d{1,3}$/.test(raw) ? raw : "7";

  const live = await fromPython(safeDays);
  if (live.text) {
    return Response.json({
      available: true, source: "live", text: live.text, chars: live.text.length,
    });
  }

  try {
    const row = await fromPublished(Number(safeDays));
    if (row) {
      const ageMs = Date.now() - new Date(row.generated_at).getTime();
      const ageHours = Math.round(ageMs / 3_600_000);
      return Response.json({
        available: true,
        source: "published",
        text: row.prompt_md,
        chars: row.chars,
        generatedAt: row.generated_at,
        asOf: row.as_of,
        score: row.score,
        letter: row.letter,
        formulaVersion: row.formula_version,
        // Surfaced so the operator is never told a cached brief is current.
        staleness: `Published ${ageHours}h ago covering closed days through ${row.as_of}. ` +
          `This is the stored copy — the agent could not be reached to rebuild it live.`,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      available: false, text: "", source: "none",
      error: msg.slice(0, 300),
      hint: /ppc_briefs/.test(msg)
        ? "Run supabase/migration_ppc_briefs.sql, then `python -m src.main ppc-export --publish` on the agent."
        : "Run `python -m src.main ppc-export --publish` on the agent.",
    });
  }

  return Response.json({
    available: false, text: "", source: "none",
    error: live.error.slice(0, 300),
    hint: "No published brief stored yet. Run `python -m src.main ppc-export --publish` " +
      "on the agent (Mac Mini), then retry — the dashboard can serve it without Python.",
  });
}
