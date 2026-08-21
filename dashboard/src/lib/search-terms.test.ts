import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Search terms must be one row per TERM, not per (day, campaign).
 *
 * The previous table selected raw daily rows with `.limit(300)` and no date
 * filter, so a single query appeared once per day per campaign — reading as if
 * it ran in a dozen different campaigns — and its totals were summed across
 * days into the "wasted spend" figure. The selected range was ignored entirely.
 */
const ROUTE = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
const PAGE = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");

test("the search-term fetch is date-bounded and paginated, not limit(300)", () => {
  const seg = ROUTE.slice(ROUTE.indexOf("ads_search_terms_daily"));
  const stmt = seg.slice(0, seg.indexOf(";"));
  assert.ok(!/\.limit\(\s*300\s*\)/.test(stmt),
    "a bare limit(300) takes the top daily rows across ALL time");
  assert.ok(stmt.includes('.gte("date"'), "must be bounded to the window");
});

test("terms are aggregated per range with a campaign breakdown", () => {
  assert.ok(ROUTE.includes("searchTermsByRange"), "expose per-range aggregates");
  assert.ok(ROUTE.includes("campaign_count"), "expose the overlap count");
  assert.ok(/campaigns:\s*TermCampaign\[\]/.test(ROUTE), "expose the drilldown rows");
});

test("the aggregation key is the normalized term, matching the rank gate", () => {
  assert.ok(ROUTE.includes("term_key"), "terms carry the normalized join key");
  assert.ok(/toLowerCase\(\)\.replace\(\/\\s\+\/g, " "\)/.test(ROUTE),
    "term_key must normalize the same way organic_rank.normalize_keyword does");
});

test("campaign rows in a drilldown are keyed by campaign_id, not name", () => {
  const seg = ROUTE.slice(ROUTE.indexOf("function termsFor"));
  assert.ok(seg.includes("camps.get(cid)"),
    "two campaigns sharing a name must stay distinct");
});

test("drilldown campaigns are sorted by spend descending", () => {
  const seg = ROUTE.slice(ROUTE.indexOf("function termsFor"));
  assert.ok(/sort\(\(a, b\) => b\.spend - a\.spend\)/.test(seg));
});

test("the page renders one row per term and no legacy per-day fields", () => {
  for (const legacy of ["orders_14d", "sales_14d", "s.match_type}", "s.campaign_name}"]) {
    assert.ok(!PAGE.includes(legacy),
      `page still reads ${legacy} — that is the per-day row shape`);
  }
  assert.ok(PAGE.includes("campaign_count > 1"), "multi-campaign badge must exist");
});

test("only one search tab block exists", () => {
  const count = (PAGE.match(/tab === "search" &&/g) ?? []).length;
  assert.equal(count, 1, "a duplicate block would render the table twice");
});

test("per-period rows are opt-in, never the default view", () => {
  assert.ok(PAGE.includes("useState(false)") && PAGE.includes("byDay"),
    "the by-period expansion must default to off");
});
