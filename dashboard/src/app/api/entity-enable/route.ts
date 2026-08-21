import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * POST /api/entity-enable — turn a contested obligation on or off.
 *
 * Writes `enabled_obligations["STATE:type"]` in config/entity_profile.json,
 * then re-runs `entity-calendar --apply` so the scheduled rows appear (or
 * disappear) without the user opening a terminal.
 *
 * This is the one place a UI action changes a compliance position, so it is
 * deliberately narrow: the key must match a rule that actually exists and is
 * marked `user_confirmed`. Anything else is rejected rather than written — the
 * profile is not a free-form key/value store, and a typo'd key would silently
 * do nothing while looking like it worked.
 */

function repoRoot(): string[] {
  return [path.join(process.cwd(), ".."), process.cwd()];
}

async function findFile(rel: string): Promise<string | null> {
  for (const root of repoRoot()) {
    const p = path.join(root, rel);
    try {
      await readFile(p, "utf8");
      return p;
    } catch { /* try the next root */ }
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const key = String(body.key ?? "");
    const enabled = body.enabled === true;

    if (!/^[A-Z]{2}:[a-z_]+$/.test(key)) {
      return Response.json(
        { ok: false, error: `Malformed key ${JSON.stringify(key)} — expected "XX:obligation_type".` },
        { status: 400 },
      );
    }

    // The key must correspond to a real user_confirmed rule.
    const rulesPath = await findFile("config/seed_entity_obligations.json");
    if (!rulesPath) {
      return Response.json({ ok: false, error: "config/seed_entity_obligations.json not found." }, { status: 500 });
    }
    const rules = JSON.parse(await readFile(rulesPath, "utf8"));
    const [state, type] = key.split(":");
    const rule = (rules.obligations ?? []).find(
      (r: { state_code?: string; obligation_type?: string; applies_when?: string }) =>
        r.state_code === state && r.obligation_type === type && r.applies_when === "user_confirmed",
    );
    if (!rule) {
      return Response.json(
        { ok: false, error: `${key} is not a review-only obligation. Only contested rules can be enabled here.` },
        { status: 400 },
      );
    }

    const profilePath = await findFile("config/entity_profile.json");
    if (!profilePath) {
      return Response.json({ ok: false, error: "config/entity_profile.json not found." }, { status: 500 });
    }
    const raw = await readFile(profilePath, "utf8");
    const profile = JSON.parse(raw);
    profile.enabled_obligations = profile.enabled_obligations ?? {};
    if (enabled) {
      profile.enabled_obligations[key] = true;
    } else {
      // Removing the key restores rule-driven behaviour (back to review-only).
      // Writing `false` would instead suppress it permanently, which is a
      // different decision and not what un-ticking a box means.
      delete profile.enabled_obligations[key];
    }
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n", "utf8");

    // Re-apply the calendar so scheduled rows reflect the change immediately.
    // Fixed argv, no interpolation of user input.
    let applied = false;
    let applyOutput = "";
    for (const root of repoRoot()) {
      try {
        const { stdout } = await run(
          path.join(root, ".venv", "bin", "python"),
          ["-m", "src.main", "entity-calendar", "--apply"],
          { cwd: root, timeout: 120_000 },
        );
        applied = true;
        applyOutput = stdout.trim().split("\n").slice(0, 4).join("\n");
        break;
      } catch (e) {
        applyOutput = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }

    return Response.json({
      ok: true,
      key,
      enabled,
      applied,
      applyOutput,
      // When the CLI could not be run (packaged deploy, no venv), the profile
      // change still landed — say so plainly rather than implying it is live.
      hint: applied
        ? null
        : "Profile updated, but the calendar was not re-applied automatically. Run: python -m src.main entity-calendar --apply",
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
