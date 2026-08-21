import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Brand-share must plot every stored week, not the oldest 1000 rows.
 *
 * sqp_weekly holds one row per (asin, query, week) — 600-900 rows for a single
 * week. PostgREST caps a response at 1000 rows, so an unpaginated
 * `select(...).order("week_start", asc)` over 23 weeks returned the two OLDEST
 * March weeks and nothing else. The card then rendered "last 2 weeks" with
 * March dates while May-August sat unread in the table, and the KPI strip
 * reported the branded mix of a five-month-old week as current.
 *
 * The chart layer stacked a second cap on top: `.slice(-15)` of an already
 * truncated payload. Two independent caps, neither visible in the output.
 */
const ROUTE = path.join(process.cwd(), "src/app/api/brand-share/route.ts");
const COMPONENT = path.join(process.cwd(), "src/components/brand-share.tsx");
const route = readFileSync(ROUTE, "utf8");
const component = readFileSync(COMPONENT, "utf8");

/**
 * Comments are stripped before any "this pattern must be absent" assertion.
 * Both files document the bugs they fixed by name, so a naive search finds
 * `slice(-15)` and `marginTop` in the prose explaining why they are gone and
 * fails on a correct file.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const routeCode = code(route);
const componentCode = code(component);

test("the route paginates sqp_weekly", () => {
  assert.ok(route.includes(".range("), "sqp_weekly must be read page by page");
  assert.match(route, /page\.length < pageSize/,
    "the loop must continue until a short page proves the end was reached");
});

test("pagination orders by a unique key, not just the week", () => {
  const orders = [...route.matchAll(/\.order\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(orders.includes("week_start"), "expected a week_start ordering");
  assert.ok(
    orders.some((c) => c !== "week_start"),
    "week_start alone leaves page boundaries undefined — hundreds of rows " +
      "share each week, so rows silently drop and duplicate across pages"
  );
});

test("no row cap is applied to the week series", () => {
  assert.doesNotMatch(routeCode, /\.limit\(\s*\d+\s*\)/,
    "a .limit() on the weekly read is a truncated history, not a window");
  assert.doesNotMatch(componentCode, /slice\(-(?:[0-9]|1[0-9]|2[0-9]|[34][0-9]|5[01])\)/,
    "the chart must not re-cap the payload below the 52-week window");
});

test("the chart plots all weeks and the label is derived, not hardcoded", () => {
  assert.doesNotMatch(componentCode, /last 2 weeks/i);
  assert.doesNotMatch(componentCode, /last \{weeks\.length\} weeks/,
    "prefer an explicit date span so a truncated payload is visible on sight");
  assert.ok(component.includes("MAX_WEEKS = 52"), "expected a 52-week window");
});

test("KPI strip, bullets and bars read one dataset", () => {
  // `latest` is the tail of the same array the bars are built from, and the
  // callouts come from the same server-side series. A separate short query for
  // the KPI numbers is what would let the strip and the chart disagree.
  assert.ok(component.includes("const latest = weeks[weeks.length - 1]"));
  assert.ok(component.includes("toColumns(weeks)"),
    "bars must derive from the same `weeks` array the KPI strip reads");
  assert.equal((component.match(/fetch\("\/api\/brand-share"/g) ?? []).length, 1,
    "exactly one fetch — a second query is how two panels start disagreeing");
});

test("missing weeks become empty columns rather than being collapsed", () => {
  assert.ok(component.includes("no SQP data stored for this week"),
    "a gap must render as a gap, not close up into an unbroken trend");
});

test("responses are not cached", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/,
    "a cached rollup would survive a sync and keep serving stale weeks");
});

test("the payload reports what it read", () => {
  assert.ok(route.includes("rowsRead"), "row count makes truncation visible");
  assert.ok(route.includes("weekCount"));
});

test("chart geometry stays clipped and bottom-anchored", () => {
  // Percentage margins resolve against the containing block's WIDTH, which is
  // what previously threw the bar out of a 64px box and over the table below.
  assert.ok(component.includes("absolute inset-x-0 bottom-0"));
  assert.ok(component.includes("overflow-hidden"));
  assert.doesNotMatch(componentCode, /marginTop/);
});

test("no Python subprocess on mount", () => {
  assert.doesNotMatch(routeCode, /child_process|execFile|spawn/);
});
