import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The LTV/AOV panel must be visible without hunting.
 *
 * It shipped correct and invisible: the deploy was live, the env was right and
 * /api/shopify-customers returned real data — but the card sat at the 91% mark
 * of /profit behind a "Load" button, under a nav entry labelled only
 * "Contribution P&L". Three compounding discoverability failures read to the
 * operator as "production does not show LTV".
 *
 * These assertions pin the three fixes, because each is the kind of thing a
 * later tidy-up silently undoes.
 */
const ROOT = process.cwd();
const card = readFileSync(path.join(ROOT, "src/components/shopify-customers.tsx"), "utf8");
const page = readFileSync(path.join(ROOT, "src/app/profit/page.tsx"), "utf8");
const nav = readFileSync(path.join(ROOT, "src/components/nav.tsx"), "utf8");

test("the panel loads on mount rather than behind a button", () => {
  assert.match(card, /useEffect\(\s*\(\)\s*=>\s*\{\s*load\(\);/,
    "a metric nobody can see without pressing a button is not shipped");
  assert.doesNotMatch(card, /:\s*d\s*\?\s*"Refresh"\s*:\s*"Load"/,
    "there should no longer be a first-run Load button");
});

test("the panel renders above the daily P&L, not buried under it", () => {
  const cardAt = page.indexOf("<ShopifyCustomers />");
  assert.ok(cardAt > -1, "profit page must mount the panel");
  const bodyAt = page.indexOf("{!hasData ?");
  assert.ok(bodyAt > -1, "expected the P&L body marker");
  assert.ok(cardAt < bodyAt,
    "panel must come before the P&L body — at the bottom it started at 91% " +
    "of page text and read as missing");
});

test("nav names customers so the page is findable", () => {
  const line = nav.split("\n").find((l) => l.includes('href: "/profit"')) ?? "";
  assert.match(line, /LTV|Customer/i,
    '"Contribution P&L" alone gives someone hunting for LTV no reason to click');
});

test("failure and empty states are visible, not blank", () => {
  assert.ok(card.includes("could not load"),
    "an error must look like an error");
  assert.ok(card.includes("Try again"), "and offer a way out");
  assert.ok(card.includes("No Shopify orders stored yet"),
    "empty must be distinguishable from broken");
  assert.ok(card.includes("aria-busy"), "loading must be announced");
});

test("the panel never labels median-all-customer as LTV on its own", () => {
  assert.ok(card.includes("typical customer ever"),
    "the all-customer median needs its qualifier attached");
  assert.ok(card.includes("Repeaters (2+ orders) — primary"),
    "repeaters are the primary customer-LTV figure");
});
