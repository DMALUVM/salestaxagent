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

test("every bar has a hover tooltip carrying the week's figures", () => {
  for (const field of ["Branded mix", "Branded purchases", "Non-brand purchases",
                       "Total", "Non-brand share"]) {
    assert.ok(componentCode.includes(field), `tooltip is missing "${field}"`);
  }
  assert.ok(componentCode.includes("onMouseEnter"), "bars must respond to hover");
  assert.ok(componentCode.includes("week_end"), "tooltip must date the week");
});

test("the tooltip is reachable without a mouse", () => {
  assert.ok(componentCode.includes("tabIndex"), "bars must be focusable");
  assert.ok(componentCode.includes("onFocus") && componentCode.includes("onBlur"));
  assert.ok(componentCode.includes("aria-label"),
    "the figures exist only in the tooltip, so each bar needs its own label");
});

/**
 * The tooltip must not live inside the bar row.
 *
 * That row is `overflow-hidden` — the belt that stops a fill escaping its 64px
 * box and painting over the opportunities table. Anything rendered inside it is
 * clipped by the same rule, so the tooltip would be sliced off at 64px.
 */
test("the tooltip escapes the clipped bar row", () => {
  const rowAt = componentCode.indexOf('style={{ height: 64 }}');
  const tipAt = componentCode.indexOf("pointer-events-none absolute top-full");
  assert.ok(rowAt > -1 && tipAt > -1, "expected both the bar row and the tooltip");
  assert.ok(tipAt > rowAt, "tooltip must be a sibling after the bar row");
  const row = componentCode.slice(rowAt, tipAt);
  assert.ok(row.includes("overflow-hidden"), "the bar row keeps its clipping");
  assert.ok(!componentCode.slice(rowAt, tipAt).includes("w-52"),
    "tooltip must sit outside the overflow-hidden row, not within it");
});

test("no per-bar printed labels — they do not fit at 24+ weeks", () => {
  // ~15px per column at 24 weeks. A "4.7%" label per bar overflows its column,
  // which is how the previous chart bug started. Hover carries the number.
  // aria-label legitimately formats a percentage — it is an attribute read by
  // screen readers, not a text node competing for 15px of column width. Only a
  // rendered child counts, so attribute values are stripped first.
  const bars = componentCode
    .slice(componentCode.indexOf("columns.map"), componentCode.indexOf("pointer-events-none"))
    .replace(/aria-label=\{[\s\S]*?\n\s*\}/g, "");
  assert.doesNotMatch(bars, />\s*\{pct\(/,
    "no percentage text rendered inside the bar columns");
  assert.doesNotMatch(bars, /%<\//, "no literal % label inside the bar columns");
});

test("the interpretation note is present", () => {
  for (const phrase of ["ASIN-level SQP", "defend", "organic-rank", "off-category"]) {
    assert.ok(componentCode.includes(phrase), `note is missing "${phrase}"`);
  }
});
