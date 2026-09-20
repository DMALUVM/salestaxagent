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
  frictionRollup,
  kitKind,
  productLeakFromAbandons,
  recoveryOf,
  stepsOf,
  sumDaily,
  summarizeKlaviyo,
  topAbandonedProducts,
  windowBounds,
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

describe("expand: kit leak + friction", () => {
  test("kitKind tokens and product leak skip blank titles", () => {
    assert.equal(kitKind("lip-balm-3-pack", "3 Pack Kit"), "kit");
    assert.equal(kitKind("mint-stick", "Mint Stick"), "stick");
    assert.equal(kitKind("tallow-balm", "Tallow Balm"), "other");
    const leak = productLeakFromAbandons([
      {
        checkout_id: "a", checkout_name: "#1", checkout_date: "2026-09-18",
        created_at: "2026-09-18T00:00:00Z", completed_at: null, total_price: 28,
        currency: "USD", recovered: false,
        line_items: [{ title: "Lip Balm 3-Pack", handle: "lip-balm-3-pack", quantity: 1, amount: 28 }],
        line_items_qty: 1, triage_severity: "hold_for_review", triage_note: null,
      },
    ]);
    assert.equal(leak.source, "abandoned_line_items");
    assert.equal(leak.kinds.find((k) => k.kind === "kit")?.open, 1);
    const fr = frictionRollup([{
      checkout_id: "a", checkout_name: "#1", checkout_date: "2026-09-18",
      created_at: "2026-09-18T00:00:00Z", completed_at: null, total_price: 28,
      currency: "USD", recovered: false, line_items: [], line_items_qty: 0,
      triage_severity: "hold_for_review", triage_note: null,
      shipping_address_started: true, has_discount: false,
      has_shipping_rate: null, payment_attempted: null,
    }]);
    assert.equal(fr.shippingAddressStarted, 1);
    assert.equal(fr.shippingRateUnknown, 1);
    assert.equal(fr.paymentAttemptUnknown, 1);
  });

  test("summarizeKlaviyo 90d combined is 180.03 + 20.81 = 200.84", () => {
    const s = summarizeKlaviyo([
      { as_of: "2026-09-19", window_days: 90, flow_id: "WcDdsx", revenue: 180.03, unique_clicks: null, conversion_metric_id: "UG4R5c" },
      { as_of: "2026-09-19", window_days: 90, flow_id: "SQa2Yy", revenue: 20.81, unique_clicks: null, conversion_metric_id: "UG4R5c" },
      { as_of: "2026-09-19", window_days: 30, flow_id: "WcDdsx", revenue: 32.55, unique_clicks: 0, conversion_metric_id: "UG4R5c" },
      { as_of: "2026-09-19", window_days: 30, flow_id: "SQa2Yy", revenue: 20.81, unique_clicks: 0, conversion_metric_id: "UG4R5c" },
    ]);
    const by = Object.fromEntries(s.windows.map((w) => [w.window_days, w]));
    assert.equal(by[90].revenue, 200.84);
    assert.equal(by[90].unique_clicks_zero, false);
    assert.equal(by[30].revenue, 53.36);
    assert.equal(by[30].unique_clicks_zero, true);
    assert.equal(s.refresh.wrote_klaviyo, false);
    assert.equal(s.refresh.method, "get_flow_report");
    const missing = summarizeKlaviyo([{ window_days: 90, revenue: null, unique_clicks: null }]);
    assert.equal(missing.windows[0].revenue, null);
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
    assert.doesNotMatch(card, /getSupabase/);
  });

  test("API is service-role only and does not invent numbers", () => {
    assert.match(route, /getServerSupabase/);
    assert.match(route, /shopify_funnel_daily/);
    assert.match(route, /shopify_abandoned_checkouts/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    assert.doesNotMatch(route, /orderCreate|sellerise/i);
    assert.doesNotMatch(route, /write_orders|draftOrderComplete/);
    const klaviyo = readFileSync(path.join(root, "src/app/api/klaviyo-abandon/route.ts"), "utf8");
    assert.match(klaviyo, /getServerSupabase/);
    assert.match(klaviyo, /klaviyo_abandon_flow_daily/);
    assert.match(klaviyo, /summarizeKlaviyo/);
    assert.doesNotMatch(klaviyo, /klaviyo\.com|profiles|events/);
  });

  test("shopper page is full-width with an error boundary", () => {
    assert.match(layout, /data-full-width/);
    assert.ok(existsSync(path.join(root, "src/app/shopper/error.tsx")));
    assert.match(page, /\/api\/shopify-funnel/);
    assert.match(page, /content-type/);
    assert.doesNotMatch(page, /getSupabase/);
    assert.doesNotMatch(page, /return <LoadingState/);
    assert.match(page, /AbortController/);
    assert.match(page, /unique clicks 0/);
    assert.match(page, /combined recovery/);
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
    const expand = readFileSync(path.join(root, "..", "supabase/migration_shopify_funnel_expand.sql"), "utf8");
    assert.match(expand, /klaviyo_abandon_flow_daily/);
    assert.match(expand, /shipping_address_started/);
    assert.match(expand, /180\.03/);
    assert.match(expand, /get_flow_report/);
    assert.match(expand, /Phase 2 connectors are out/);
    assert.doesNotMatch(expand, /TODO\(phase2-ga4\)/);
    assert.doesNotMatch(expand, /CREATE POLICY/i);
  });
});
