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
  // Accepts a plain string or a template literal — the hover state made the
  // class list conditional, but the h-full prefix is the load-bearing part.
  assert.ok(/className=[{"`]*`?flex h-full min-w-\[8px\] flex-1 items-end/.test(chart),
    "each day column must be h-full so its bars have a definite parent height");
  assert.ok(/Math\.max\(\s*0,\s*Math\.min\(\s*100/.test(src),
    "the fill percentage must be clamped to 0..100");
});

/**
 * The four series are only distinguishable by colour, so the numbers have to
 * live somewhere reachable.
 *
 * Live regression: the first attempt used an absolutely positioned hover card
 * at `top-full` under the bars. `Card` (components/ui/card.tsx) ships with
 * overflow-hidden, so the card clipped the tooltip no matter how its left
 * offset was clamped — only the first three rows were ever visible. The fix is
 * an IN-FLOW readout that reserves its own space, which also means the figures
 * are readable on a touch screen where there is no hover at all.
 */
test("the paid-ads chart figures are in-flow, not an absolute card that Card clips", () => {
  const src = read("paid-ads-intel.tsx");
  const dual = src.slice(src.indexOf("function DualChart("), src.indexOf("function ChartSpark("));
  const spark = src.slice(src.indexOf("function ChartSpark("), src.indexOf("function IntelCardView("));

  for (const [name, chart] of [["spend chart", dual], ["sparkline", spark]] as const) {
    assert.ok(!/title={`/.test(chart),
      `${name} must not fall back to a native title tooltip`);
    assert.ok(chart.includes("onMouseEnter") && chart.includes("onFocus") && chart.includes("onBlur"),
      `${name} must respond to pointer and keyboard focus`);
    assert.ok(chart.includes("tabIndex={0}"),
      `${name} bars must be focusable so the figures are reachable without a mouse`);
    assert.ok(chart.includes("aria-label"),
      `${name} needs its figures announced to screen readers`);

    // The readout must not be positioned outside the content box.
    assert.ok(!/absolute top-full/.test(chart),
      `${name} must not position its readout below the content box — Card clips it`);
    assert.ok(!/left: `clamp\(/.test(chart),
      `${name} should not need an offset clamp; the readout is in normal flow`);
    assert.ok(/newest day/.test(chart),
      `${name} readout must default to a day so it is never blank without hover`);
  }
});

test("the paid-ads chart states its scale and prints day values when they fit", () => {
  const src = read("paid-ads-intel.tsx");
  const dual = src.slice(src.indexOf("function DualChart("), src.indexOf("function ChartSpark("));
  assert.ok(/Scale: top of chart/.test(dual),
    "a bar height means nothing without the value at full height");
  assert.ok(/const dense = shown\.length <= 10/.test(dual),
    "printed per-day values must be gated on the window being short enough to fit");
  assert.ok(/tickEvery/.test(dual),
    "date ticks must thin out on longer windows instead of overlapping");
});

test("the sparkline reports clicks, impressions, CTR and position", () => {
  const src = read("paid-ads-intel.tsx");
  const spark = src.slice(src.indexOf("function ChartSpark("), src.indexOf("function IntelCardView("));
  for (const label of ["Clicks", "Impressions", "CTR", "Avg position"]) {
    assert.ok(spark.includes(`label="${label}"`),
      `the sparkline readout must show ${label}`);
  }
});

/**
 * `absolute top-full` is only safe when more content follows inside the same
 * card — brand-share gets away with it because its opportunities table sits
 * below the chart, so the hover card lands on the table rather than past the
 * card edge. The paid-ads chart sits at the bottom of its card, where the same
 * pattern was silently clipped. Any chart using it must keep content below.
 */
test("a chart that overflows its content box has content below to land on", () => {
  for (const f of files) {
    const src = read(f);
    let from = src.indexOf("absolute top-full");
    while (from !== -1) {
      const after = src.slice(from);
      assert.ok(
        /<\/?(table|Table|CardFooter)/.test(after),
        `${f} positions an element below its content box with nothing after it. ` +
        `Card has overflow-hidden and will clip it — put the figures in normal flow.`,
      );
      from = src.indexOf("absolute top-full", from + 1);
    }
  }
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
