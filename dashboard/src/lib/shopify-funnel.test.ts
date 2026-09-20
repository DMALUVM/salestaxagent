import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  biggestLeak,
  closedDropOff,
  conversionRate,
  dropOff,
  filterAbandoned,
  recoveryOf,
  stepsOf,
  sumDaily,
  topAbandonedProducts,
  windowBounds,
  windowEnd,
  type AbandonedRow,
} from "./shopify-funnel";

function daily(
  d: string,
  sessions: number | null,
  extra: Record<string, unknown> = {},
) {
  return {
    metric_date: d, split_kind: "all", split_value: "",
    sessions, pdp_sessions: extra.pdp ?? null,
    add_to_cart: extra.atc ?? null,
    checkout_started: extra.chk ?? null,
    purchases: extra.purch ?? null,
  };
}

describe("drop-off math", () => {
  test("computes lost / rate / conversion by hand", () => {
    const d = dropOff(100, 40);
    assert.equal(d.lost, 60);
    assert.equal(d.rate, 0.6);
    assert.equal(d.conversion, 0.4);
    assert.equal(d.nested, true);
  });

  test("missing counts stay null — never a 100% leak", () => {
    const d = dropOff(100, null);
    assert.equal(d.lost, null);
    assert.equal(d.rate, null);
    assert.equal(d.present, false);
  });

  test("non-nested PDP vs ATC does not invent a leak", () => {
    const d = dropOff(20, 35);
    assert.equal(d.nested, false);
    assert.equal(d.lost, null);
    assert.equal(d.rate, null);
  });
});

describe("window rollup", () => {
  test("sumDaily does not coerce a missing day into zero", () => {
    const c = sumDaily([
      daily("2026-09-10", 10, { pdp: 4, atc: 3, chk: 2, purch: 1 }),
      daily("2026-09-11", 10, { chk: 1, purch: 0 }),
      { ...daily("2026-09-11", 99), split_kind: "device", split_value: "Mobile" },
    ], "2026-09-10", "2026-09-11");
    assert.equal(c.sessions, 20);
    assert.equal(c.pdpSessions, 4);
    assert.equal(c.addToCart, 3);
    assert.equal(c.checkoutStarted, 3);
    assert.equal(c.purchases, 1);
  });

  test("windowBounds is inclusive of the end date", () => {
    assert.deepEqual(windowBounds("2026-09-20", 7), {
      start: "2026-09-14", end: "2026-09-20",
    });
    assert.equal(windowBounds("2026-09-20", 28).start, "2026-08-24");
  });

  test("windowEnd uses abandons when ShopifyQL days are missing", () => {
    assert.equal(windowEnd([], ["2026-09-10", "2026-09-18"]), "2026-09-18");
    assert.equal(windowEnd(["2026-09-12"], ["2026-09-18"]), "2026-09-12");
    assert.equal(windowEnd([], []), null);
  });
});

describe("leak + steps", () => {
  test("biggest leak is count, not rate", () => {
    const leak = biggestLeak({
      sessions: 1000, pdpSessions: null, addToCart: 200,
      checkoutStarted: 180, purchases: 18,
    });
    assert.equal(leak?.from, "sessions");
    assert.equal(leak?.to, "addToCart");
    assert.equal(leak?.lost, 800);
  });

  test("closed funnel ignores PDP", () => {
    const path = closedDropOff({
      sessions: 100, pdpSessions: 10, addToCart: 40,
      checkoutStarted: 20, purchases: 10,
    });
    assert.deepEqual(path.map((d) => d.from), ["sessions", "addToCart", "checkoutStarted"]);
  });

  test("steps omit PDP when the count is missing", () => {
    const keys = stepsOf({
      sessions: 10, pdpSessions: null, addToCart: 4,
      checkoutStarted: 2, purchases: 1,
    }).map((s) => s.key);
    assert.equal(keys.includes("pdp_sessions"), false);
  });

  test("session-to-purchase conversion", () => {
    assert.equal(conversionRate(200, 10), 0.05);
    assert.equal(conversionRate(0, 1), null);
    assert.equal(conversionRate(null, 1), null);
  });
});

describe("abandons", () => {
  function row(partial: Partial<AbandonedRow>): AbandonedRow {
    return {
      checkout_id: "gid://x/1",
      checkout_name: "#1",
      checkout_date: "2026-09-18",
      created_at: "2026-09-18T16:00:00Z",
      completed_at: null,
      total_price: 32,
      currency: "USD",
      recovered: false,
      line_items: [{ title: "Tallow Balm", quantity: 2, handle: "tallow-balm", amount: 28 }],
      line_items_qty: 2,
      triage_severity: "hold_for_review",
      triage_note: "stub",
      ...partial,
    };
  }

  test("recovery rate and open $ skip recovered / missing amounts", () => {
    const r = recoveryOf([
      row({ checkout_id: "a", total_price: 40, recovered: false }),
      row({ checkout_id: "b", total_price: 99, recovered: true, completed_at: "2026-09-19T00:00:00Z" }),
      row({ checkout_id: "c", total_price: null, recovered: false }),
    ]);
    assert.equal(r.count, 3);
    assert.equal(r.recovered, 1);
    assert.equal(r.open, 2);
    assert.equal(r.openValue, 40);
    assert.equal(r.openValueMissing, 1);
  });

  test("top products skip recovered and blank titles", () => {
    const top = topAbandonedProducts([
      row({ recovered: true, completed_at: "2026-09-19T00:00:00Z" }),
      row({ checkout_id: "open" }),
      row({
        checkout_id: "blank",
        line_items: [{ title: "  ", quantity: 9, amount: 10 }],
      }),
    ]);
    assert.deepEqual(top.map((t) => t.title), ["Tallow Balm"]);
    assert.equal(top[0].quantity, 2);
    assert.equal(top[0].amount, 28);
  });

  test("filterAbandoned is inclusive on checkout_date", () => {
    const rows = [
      row({ checkout_date: "2026-09-01" }),
      row({ checkout_date: "2026-09-18" }),
    ];
    assert.equal(filterAbandoned(rows, "2026-09-14", "2026-09-20").length, 1);
  });
});

describe("wiring", () => {
  const root = process.cwd();
  const nav = readFileSync(path.join(root, "src/components/nav.tsx"), "utf8");
  const overview = readFileSync(path.join(root, "src/app/page.tsx"), "utf8");
  const route = readFileSync(path.join(root, "src/app/api/shopify-funnel/route.ts"), "utf8");
  const page = readFileSync(path.join(root, "src/app/shopper/page.tsx"), "utf8");
  const card = readFileSync(path.join(root, "src/components/shopify-funnel-health.tsx"), "utf8");
  const layout = readFileSync(path.join(root, "src/app/shopper/layout.tsx"), "utf8");

  test("nav lists the shopper page under Monitoring", () => {
    assert.match(nav, /href: "\/shopper"/);
    assert.match(nav, /Shopper funnel/);
  });

  test("Overview mounts the thin funnel-health card", () => {
    assert.match(overview, /ShopifyFunnelHealth/);
    // Card must still mount while Pulse sales queries are loading.
    const loadGate = overview.match(/if \(l1 \|\| l2 \|\| l3\)[\s\S]{0,350}/);
    assert.ok(loadGate, "Pulse still has the l1||l2||l3 loading gate");
    assert.match(loadGate[0], /ShopifyFunnelHealth/);
    assert.match(card, /AbortController/);
    assert.match(card, /\/api\/shopify-funnel/);
    assert.match(card, /content-type/);
    assert.match(card, /sessions blank — needs read_reports/);
    assert.match(card, /We do not fill sessions from orders/);
    assert.doesNotMatch(card, /getSupabase/);
    assert.doesNotMatch(card, /shopify_orders/);
  });

  test("API is service-role only and does not invent numbers", () => {
    assert.match(route, /getServerSupabase/);
    assert.match(route, /shopify_funnel_daily/);
    assert.match(route, /shopify_abandoned_checkouts/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    assert.doesNotMatch(route, /orderCreate|sellerise/i);
    assert.doesNotMatch(route, /write_orders|draftOrderComplete/);
    assert.match(route, /windowEnd/);
    assert.match(route, /\.\/\.venv\/bin\/python -m src\.main shopify-funnel-sync/);
    assert.doesNotMatch(route, /`python -m src\.main shopify-funnel-sync`/);
    assert.doesNotMatch(route, /shopify_orders/);
    assert.doesNotMatch(route, /klaviyo|google ads|gsc/i);
    assert.doesNotMatch(route, /AI_GATEWAY_API_KEY/);
  });

  test("shopper page is full-width with an error boundary", () => {
    assert.match(layout, /data-full-width/);
    assert.ok(existsSync(path.join(root, "src/app/shopper/error.tsx")));
    assert.match(page, /\/api\/shopify-funnel/);
    assert.match(page, /content-type/);
    assert.doesNotMatch(page, /getSupabase/);
    assert.doesNotMatch(page, /return <LoadingState/);
    assert.match(page, /AbortController/);
    assert.match(page, /read_reports/);
    assert.match(page, /greenlit min READ/);
    assert.match(page, /no theme/);
    assert.doesNotMatch(page, /klaviyo_abandon|place order/i);
  });

  test("Triage definition says Jev runs on Vercel, not that it is unwired", () => {
    const defs = readFileSync(path.join(root, "src/lib/shopify-funnel.ts"), "utf8");
    assert.match(defs, /Jev leak triage runs on Vercel/);
    assert.match(defs, /shopify-funnel-sync does not call an LLM/);
    assert.doesNotMatch(defs, /until Jev is wired/);
  });

  test("migration enables RLS and stores no recovery URL", () => {
    const sql = readFileSync(path.join(root, "..", "supabase/migration_shopify_funnel.sql"), "utf8");
    assert.match(sql, /shopify_funnel_daily/);
    assert.match(sql, /shopify_abandoned_checkouts/);
    assert.match(sql, /enable row level security/i);
    const executable = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    assert.doesNotMatch(executable, /CREATE POLICY/i);
    assert.doesNotMatch(executable, /abandoned_checkout_url|abandonedCheckoutUrl/);
    assert.match(sql, /TODO\(jev\)/);
  });
});
