import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * A page must render without any subprocess.
 *
 * Live regression: the playbook and registration-plan panels fetched routes that
 * shell out to the Python CLI from a mount effect. On a serverless deploy the
 * venv does not exist, so every page view spawned a doomed subprocess and an
 * optional panel became a hard dependency of the route rendering at all.
 *
 * Shell-out routes are fine — they just have to be triggered by a click.
 */
const API = path.join(process.cwd(), "src/app/api");
const COMPONENTS = path.join(process.cwd(), "src/components");
const APP = path.join(process.cwd(), "src/app");

/** Routes whose handler spawns a process. */
function shellRoutes(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(API, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(API, dir.name, "route.ts");
    if (!existsSync(f)) continue;
    if (/child_process/.test(readFileSync(f, "utf8"))) out.push(dir.name);
  }
  return out;
}

function sources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "api") walk(p); }
      else if (e.name.endsWith(".tsx")) out.push({ file: p, src: readFileSync(p, "utf8") });
    }
  };
  walk(COMPONENTS);
  walk(APP);
  return out;
}

test("no component fetches a shell-out route from a mount effect", () => {
  const routes = shellRoutes();
  assert.ok(routes.length > 0, "expected some routes to shell out");
  for (const { file, src } of sources()) {
    const effects = [...src.matchAll(/useEffect\(\s*(\(\)|load|\w+)\s*=>?[\s\S]{0,400}?\}\s*,\s*\[/g)];
    for (const m of effects) {
      for (const r of routes) {
        assert.ok(
          !m[0].includes(`/api/${r}`),
          `${path.basename(file)} fetches /api/${r} on mount, but that route ` +
          `spawns a subprocess. Load it from a click instead.`,
        );
      }
    }
  }
});

test("routes that shell out never run at page render", () => {
  // A server component awaiting one of these would run it during SSR.
  for (const { file, src } of sources()) {
    if (src.includes('"use client"')) continue;
    for (const r of shellRoutes()) {
      assert.ok(!src.includes(`/api/${r}`),
        `${path.basename(file)} is a server component referencing /api/${r}`);
    }
  }
});

test("/ppc has an error boundary", () => {
  assert.ok(existsSync(path.join(APP, "ppc/error.tsx")),
    "without error.tsx a client exception renders the bare crash screen");
});

test("fetches guard against non-JSON responses", () => {
  // A gateway timeout returns HTML; .json() on it throws and kills the render.
  for (const name of ["ppc-playbook.tsx", "registration-plan.tsx"]) {
    const src = readFileSync(path.join(COMPONENTS, name), "utf8");
    assert.ok(src.includes("content-type"),
      `${name} must check content-type before calling .json()`);
  }
});

test("the ppc page reports a fatal load error instead of an empty account", () => {
  const src = readFileSync(path.join(APP, "ppc/page.tsx"), "utf8");
  assert.ok(src.includes("fatalError"), "page must surface a load failure");
});
