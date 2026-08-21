import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getServerSupabase } from "@/lib/supabase-server";

const run = promisify(execFile);

/**
 * GET /api/ppc-export — the full PPC Command Brief.
 *
 *   ?days=7          window length
 *   ?download=1      return the markdown as a file attachment
 *   ?brief=1         markdown body only, without the AI instruction wrapper
 *
 * Two paths, in order:
 *
 *  1. **Live** — shell to the Python builder, which is the only implementation
 *     of the brief and of the grading formula. A live build always agrees with
 *     `python -m src.main ppc-export`.
 *
 *  2. **Published** — newest row from `ppc_briefs`, written by
 *     `ppc-export --publish`. Vercel has no interpreter, so without this the
 *     button could only ever fail there.
 *
 * Reimplementing the builder in TypeScript was rejected deliberately: the brief
 * carries a 0-100 grade, and two implementations of weighted arithmetic drift.
 * The failure mode is the CLI and the dashboard handing the operator two
 * different grades for the same week with no way to tell which is right.
 *
 * Never called during /ppc render — button-only. See render-safety.test.ts.
 */
export const dynamic = "force-dynamic";

type Brief = {
  source: "live" | "published";
  asOf: string | null;
  text: string;
  briefMd: string;
  chars: number;
  score?: number | null;
  letter?: string | null;
  formulaVersion?: string | null;
  generatedAt?: string | null;
  formatVersion?: string | null;
  staleness?: string;
};

async function fromPython(days: string): Promise<{ brief: Brief | null; error: string }> {
  const roots = [path.join(process.cwd(), ".."), process.cwd()];
  let lastErr = "";
  for (const root of roots) {
    try {
      // --emit-json so the metadata (as-of, score, formula version) arrives as
      // data. Regexing the as-of date back out of the rendered markdown to name
      // the download file would couple this route to the brief's headings.
      const { stdout } = await run(
        path.join(root, ".venv", "bin", "python"),
        ["-m", "src.main", "ppc-export", "--days", days, "--emit-json"],
        { cwd: root, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const d = JSON.parse(stdout);
      return {
        brief: {
          source: "live", asOf: d.as_of, text: d.prompt_md, briefMd: d.brief_md,
          chars: d.chars, score: d.score, letter: d.letter,
          formulaVersion: d.formula_version,
        },
        error: "",
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { brief: null, error: lastErr || "python produced no output" };
}

async function fromPublished(days: number): Promise<Brief | null> {
  const sb = getServerSupabase();
  const r = await sb
    .from("ppc_briefs")
    .select("prompt_md,brief_md,chars,generated_at,as_of,score,letter,formula_version,grade")
    .eq("days", days)
    .order("generated_at", { ascending: false })
    .limit(1);
  if (r.error) throw new Error(r.error.message);
  const row = r.data?.[0];
  if (!row) return null;

  const ageHours = Math.round((Date.now() - new Date(row.generated_at).getTime()) / 3_600_000);
  // The section-contract version the brief was RENDERED with, distinct from the
  // grade formula version. A stored copy can predate a format change entirely —
  // the first row in this table still carried the old prose action list and the
  // manager questions the policy now bans. Announcing stale data while silently
  // serving a stale layout is the failure worth naming.
  const fmt = (row.grade as { format_version?: string } | null)?.format_version ?? "pre-2.0.0";
  return {
    source: "published", asOf: row.as_of, text: row.prompt_md,
    briefMd: row.brief_md, chars: row.chars, score: row.score, letter: row.letter,
    formulaVersion: row.formula_version, generatedAt: row.generated_at,
    formatVersion: fmt,
    staleness: `Published ${ageHours}h ago covering closed days through ${row.as_of}, ` +
      `format ${fmt}. This is the stored copy — the agent could not be reached to ` +
      `rebuild it live.`,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("days") ?? "7";
  const safeDays = /^\d{1,3}$/.test(raw) ? raw : "7";
  const download = url.searchParams.get("download") === "1";
  const bodyOnly = url.searchParams.get("brief") === "1";

  let brief: Brief | null = null;
  let error = "";
  let hint = "";

  const live = await fromPython(safeDays);
  if (live.brief) {
    brief = live.brief;
  } else {
    error = live.error;
    try {
      brief = await fromPublished(Number(safeDays));
      if (!brief) {
        hint =
          "No published brief stored yet. Run `python -m src.main ppc-export --publish` " +
          "on the agent (Mac Mini), then retry.";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg;
      hint = /ppc_briefs/.test(msg)
        ? "Run supabase/migration_ppc_briefs.sql, then `python -m src.main ppc-export --publish`."
        : "Run `python -m src.main ppc-export --publish` on the agent.";
    }
  }

  if (!brief) {
    // A download that fails must fail as JSON the caller can read, never as an
    // empty file the operator only discovers is empty after opening it.
    return Response.json({
      available: false, source: "none", text: "", chars: 0,
      error: error.slice(0, 300), hint,
    }, { status: download ? 503 : 200 });
  }

  if (download) {
    const body = bodyOnly ? brief.briefMd : brief.text;
    // "stored" in the filename so a cached brief is identifiable on disk, long
    // after the UI warning that produced it has been dismissed and forgotten.
    const stamp = brief.asOf ?? "unknown";
    const name = brief.source === "published"
      ? `ppc-command-brief-${stamp}-stored.md`
      : `ppc-command-brief-${stamp}.md`;
    return new Response(body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Brief-Source": brief.source,
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json({
    available: true, source: brief.source, text: brief.text,
    briefMd: brief.briefMd, chars: brief.chars, asOf: brief.asOf,
    score: brief.score, letter: brief.letter,
    formulaVersion: brief.formulaVersion, generatedAt: brief.generatedAt,
    formatVersion: brief.formatVersion, staleness: brief.staleness,
  });
}
