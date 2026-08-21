/**
 * Guard against React error #310 — "Rendered more hooks than during the
 * previous render."
 *
 * /ppc crashed because `const [exporting, setExporting] = useState(false)` was
 * written next to the function that used it, which put it *below*
 * `if (loading) return <LoadingState />`. The loading render therefore called
 * one fewer hook than the loaded render, and React tore the tree down the
 * instant data arrived — so the page died on exactly the transition every real
 * visit makes.
 *
 * The check runs the real `react-hooks/rules-of-hooks` rule rather than a
 * regex over the source. A hand-rolled scanner cannot tell a top-level early
 * return from a `return` inside a `useMemo` callback or a nested component,
 * and a test that cries wolf gets deleted. ESLint already knows where the
 * component boundaries are, so this defers to it.
 *
 * Scope note: every page under src/app is linted, not merely /ppc. Several
 * other pages open with `if (!isConfigured()) return <SetupPrompt />` before
 * their hooks. Those have never crashed because `isConfigured()` reads env at
 * module scope and cannot change between renders, so the hook count is stable
 * in practice — but it is the identical shape, and it stops being benign the
 * moment someone widens the condition to include a loading or error flag.
 * Failing on them now is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

const TIMEOUT = 120_000;

async function violations(patterns: string[]) {
  const reactHooks = (await import("eslint-plugin-react-hooks")).default;
  const tsParser = await import("@typescript-eslint/parser");

  // A dynamic-import namespace does not structurally match ESLint's `Parser`
  // and `Plugin` types even though it is exactly what ESLint expects at run
  // time, so the config object is cast once here rather than each field being
  // loosened individually.
  const overrideConfig = {
    // Flat config defaults to .js only, so .tsx would be reported as
    // "all files ignored" — a silent pass dressed up as an error.
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: { "react-hooks/rules-of-hooks": "error" },
  } as unknown as ESLint.Options["overrideConfig"];

  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig });

  const results = await eslint.lintFiles(patterns);
  return results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === "react-hooks/rules-of-hooks")
      .map((m) => `${r.filePath.split("/dashboard/")[1]}:${m.line} ${m.message.split(".")[0]}`)
  );
}

test("/ppc calls every hook unconditionally", { timeout: TIMEOUT }, async () => {
  const found = await violations([
    "src/app/ppc/**/*.tsx",
    "src/components/ppc-playbook.tsx",
    "src/components/brand-share.tsx",
    "src/components/sqp-status.tsx",
    "src/components/loading.tsx",
  ]);
  assert.deepEqual(
    found,
    [],
    "Hooks must all run before any early return, in the same order every " +
      "render. Move the hook up to the top-level hook block:\n  " +
      found.join("\n  ")
  );
});

/**
 * Files that already violated the rule before this test existed.
 *
 * Both open with `if (!isConfigured()) return <SetupPrompt />` ahead of their
 * hooks. That has never crashed, because `isConfigured()` reads build-time env
 * and returns the same value for every render of a session — the hook count is
 * wrong in shape but constant in practice. /ppc differed in exactly one way:
 * it gated on `loading`, which flips, so its hook count actually changed.
 *
 * They are pinned rather than fixed because this change was scoped to /ppc.
 * The list may only shrink — a new offending file fails the test, and so does
 * a stale entry, so deleting the guard clause here is what removes the name.
 */
const KNOWN = ["src/app/inventory/page.tsx", "src/app/inventory/plan/page.tsx"];

test("no new page or component calls hooks conditionally", { timeout: TIMEOUT }, async () => {
  const found = await violations(["src/app/**/*.tsx", "src/components/**/*.tsx"]);
  const fresh = found.filter((v) => !KNOWN.some((k) => v.startsWith(`${k}:`)));
  assert.deepEqual(fresh, [], `react-hooks/rules-of-hooks:\n  ${fresh.join("\n  ")}`);

  // Keeps the baseline honest: once a pinned file is cleaned up, it has to
  // leave this list or the test starts lying about outstanding work.
  const stale = KNOWN.filter((k) => !found.some((v) => v.startsWith(`${k}:`)));
  assert.deepEqual(stale, [], `Fixed — remove from KNOWN:\n  ${stale.join("\n  ")}`);
});
