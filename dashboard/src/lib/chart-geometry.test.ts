import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Bar fills must be contained by their own column.
 *
 * Live regression: the branded-mix chart positioned each fill with
 * `marginTop: "<100 - fill>%"`. CSS percentage margins resolve against the
 * containing block's **width**, not its height — so in a ~900px-wide chart a
 * 2.7% mix produced marginTop ≈ 160px inside a 64px-tall box, and the solid
 * blue bar rendered 137px BELOW the chart, painting over the middle of the
 * "Top non-brand opportunities" table.
 *
 * The fix is bottom-anchored absolute positioning plus overflow-hidden. These
 * tests keep both, and keep the data table free of any bar styling.
 */
const COMPONENTS = path.join(process.cwd(), "src/components");
const files = readdirSync(COMPONENTS).filter((f) => f.endsWith(".tsx"));

function read(f: string): string {
  return readFileSync(path.join(COMPONENTS, f), "utf8");
}

test("no component positions an element with a percentage vertical margin", () => {
  for (const f of files) {
    const src = read(f);
    const bad = /margin(Top|Bottom):\s*`\$\{[^`]*\}%`/.exec(src);
    assert.equal(
      bad, null,
      `${f} uses a percentage vertical margin for layout. Percentage margins ` +
      `resolve against WIDTH, not height — use absolute bottom-0 + height%.`,
    );
  }
});

test("the branded-mix chart clips its own bars", () => {
  const src = read("brand-share.tsx");
  const chart = src.slice(src.indexOf("Branded mix by week"));
  const column = chart.slice(0, chart.indexOf("</div>", chart.indexOf("absolute")));
  assert.ok(column.includes("overflow-hidden"),
    "the bar column must clip its fill so nothing escapes the chart");
  assert.ok(column.includes("relative"),
    "the bar column must be the positioning context for its fill");
  assert.ok(column.includes("absolute inset-x-0 bottom-0"),
    "the fill must be anchored to the bottom of its own column");
});

/**
 * Live regression: the Paid Ads spend-vs-value chart rendered completely blank.
 * The day column was `flex items-end` with NO height, so each bar's
 * `height: <pct>%` resolved against an auto-height parent and collapsed to 0.
 * A percentage height needs a definite parent height — h-full inside a fixed box.
 */
test("the paid-ads chart gives its bars a definite parent height", () => {
  const src = read("paid-ads-intel.tsx");
  const bar = src.slice(src.indexOf("function Bar("), src.indexOf("function DualChart("));
  assert.ok(bar.includes("h-full"),
    "each bar column must have a definite height or its percentage fill collapses");
  assert.ok(bar.includes("absolute inset-x-0 bottom-0"),
    "the fill must be bottom-anchored inside its own column");
  assert.ok(bar.includes("overflow-hidden"),
    "the bar column must clip its fill");

  const chart = src.slice(src.indexOf("function DualChart("), src.indexOf("function IntelCardView("));
  assert.ok(/style=\{\{ height: CHART_HEIGHT \}\}/.test(chart),
    "the chart box needs an explicit pixel height for the percentage fills to resolve");
  assert.ok(/className="flex h-full min-w-\[8px\] flex-1 items-end/.test(chart),
    "each day column must be h-full so its bars have a definite parent height");
  assert.ok(/Math\.max\(\s*0,\s*Math\.min\(\s*100/.test(src),
    "the fill percentage must be clamped to 0..100");
});

test("the bar fill percentage is clamped to 0..100", () => {
  const src = read("brand-share.tsx");
  assert.ok(/Math\.max\(\s*0,\s*Math\.min\(\s*100/.test(src),
    "a mix above maxMix or below zero must not produce an out-of-range height");
});

test("the opportunities table is plain rows with no bar styling", () => {
  const src = read("brand-share.tsx");
  const table = src.slice(src.indexOf("Top non-brand opportunities"));
  const body = table.slice(0, table.indexOf("</table>"));
  for (const banned of ["absolute", "bg-[#", "style={{ width", "progress"]) {
    assert.ok(
      !body.includes(banned),
      `the opportunities table must be plain rows — found "${banned}", which ` +
      `is how a chart element ends up drawn over table content`,
    );
  }
});
