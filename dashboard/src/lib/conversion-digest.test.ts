import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import {
  buildConversionDigest,
  defaultDigestAsOf,
  DEFINITIONS_NOTE,
  DIGEST_SOURCE,
  funnelFromCounts,
  improvementsFromJev,
  parseDigestDate,
} from "./conversion-digest";
import type { AbandonedRow } from "./shopify-funnel";

const NOW = new Date("2026-09-20T16:00:00.000Z"); // 12:00 EDT → today ET 2026-09-20

function daily(partial: Record<string, unknown> = {}) {
  return {
    metric_date: "2026-09-19",
    split_kind: "all",
    split_value: "",
    sessions: 100,
    pdp_sessions: 40,
    add_to_cart: 25,
    checkout_started: 10,
    purchases: 4,
    ...partial,
  };
}

function abandon(partial: Partial<AbandonedRow> = {}): AbandonedRow {
  return {
    checkout_id: "gid://x/1",
    checkout_name: "#1",
    checkout_date: "2026-09-19",
    created_at: "2026-09-19T16:00:00Z",
    completed_at: null,
    total_price: 32,
    currency: "USD",
    recovered: false,
    line_items: [{ title: "Tallow Balm", quantity: 2, amount: 28 }],
    line_items_qty: 2,
    triage_severity: "hold_for_review",
    triage_note: "stub",
    ...partial,
  };
}

describe("date lock", () => {
  test("default as_of is yesterday America/New_York", () => {
    assert.equal(defaultDigestAsOf(NOW), "2026-09-19");
    assert.equal(parseDigestDate(null, NOW).asOf, "2026-09-19");
    assert.equal(parseDigestDate("", NOW).asOf, "2026-09-19");
    assert.equal(parseDigestDate("2026-09-18", NOW).asOf, "2026-09-18");
  });

  test("invalid date does not become yesterday", () => {
    const p = parseDigestDate("nope", NOW);
    assert.equal(p.asOf, "nope");
    assert.match(p.error ?? "", /YYYY-MM-DD/);
    const d = buildConversionDigest({
      asOf: "nope", now: NOW, dailyRow: daily(), funnelOk: true,
      abandons: [], jev: { ran: true, decision: "pursue", pursue: [{ severity: "p0" }] },
    });
    assert.equal(d.status, "GAP");
    assert.equal(d.as_of, "nope");
    assert.equal(d.funnel.sessions, null);
    assert.equal(d.improvements.length, 0);
    assert.match(d.gap ?? "", /Not substituting/);
  });

  test("missing prior-day row is GAP and does not use an older row", () => {
    const older = daily({ metric_date: "2026-09-18", sessions: 999 });
    const d = buildConversionDigest({
      asOf: "2026-09-19",
      now: NOW,
      dailyRow: null,
      funnelOk: true,
      abandons: [abandon({ checkout_date: "2026-09-18", total_price: 500 })],
      jev: null,
    });
    assert.equal(d.status, "GAP");
    assert.equal(d.as_of, "2026-09-19");
    assert.equal(d.funnel.sessions, null);
    assert.equal(d.primary_leak, null);
    assert.equal(d.abandons.open_count, 0);
    assert.equal(d.improvements.length, 0);
    assert.match(d.gap ?? "", /No shopify_funnel_daily row/);
    assert.match(d.gap ?? "", /Not substituting/);
    assert.notEqual(d.funnel.sessions, older.sessions);
  });

  test("today ET is GAP, not a substitute older complete day", () => {
    const d = buildConversionDigest({
      asOf: "2026-09-20",
      now: NOW,
      dailyRow: daily({ metric_date: "2026-09-19" }),
      funnelOk: true,
      abandons: [],
      jev: null,
    });
    assert.equal(d.status, "GAP");
    assert.equal(d.funnel.sessions, null);
    assert.match(d.gap ?? "", /prior-day only|Not substituting/);
  });
});

describe("CLEAR / HOLD", () => {
  test("CLEAR when the requested day row exists and funnel_ok", () => {
    const d = buildConversionDigest({
      asOf: "2026-09-19",
      now: NOW,
      dailyRow: daily(),
      funnelOk: true,
      abandons: [abandon(), abandon({
        checkout_id: "gid://x/2", recovered: true,
        completed_at: "2026-09-19T18:00:00Z", total_price: 99,
      })],
      jev: { ran: false, reason: "vercel_runtime" },
    });
    assert.equal(d.status, "CLEAR");
    assert.equal(d.gap, null);
    assert.equal(d.as_of, "2026-09-19");
    assert.equal(d.funnel.sessions, 100);
    assert.equal(d.funnel.pdp_sessions, 40);
    assert.equal(d.funnel.add_to_cart, 25);
    assert.equal(d.funnel.checkout_started, 10);
    assert.equal(d.funnel.purchases, 4);
    assert.equal(d.funnel.rates.session_to_purchase, 0.04);
    assert.equal(d.primary_leak?.from, "sessions");
    assert.equal(d.primary_leak?.to, "add_to_cart");
    assert.equal(d.primary_leak?.lost, 75);
    assert.equal(d.abandons.open_count, 1);
    assert.equal(d.abandons.open_value, 32);
    assert.equal(d.abandons.currency, "USD");
    assert.equal(d.abandons.top_products[0]?.title, "Tallow Balm");
    assert.equal(d.abandons.top_products[0]?.qty, 2);
    assert.equal(d.abandons.top_products[0]?.value, 28);
    assert.deepEqual(d.improvements, []);
    assert.equal(d.definitions_note, DEFINITIONS_NOTE);
    assert.equal(d.source, DIGEST_SOURCE);
  });

  test("HOLD when funnel_ok is false even if a row exists", () => {
    const d = buildConversionDigest({
      asOf: "2026-09-19",
      now: NOW,
      dailyRow: daily(),
      funnelOk: false,
      abandons: [abandon()],
      jev: null,
    });
    assert.equal(d.status, "HOLD");
    assert.match(d.gap ?? "", /funnel_ok/);
    assert.equal(d.funnel.sessions, 100);
    assert.equal(d.as_of, "2026-09-19");
  });
});

describe("improvements from Jev pursue", () => {
  test("empty when Jev missing or fail-closed — no fluff", () => {
    for (const jev of [
      null,
      { ran: false, reason: "missing_gateway_key" },
      { ran: false, reason: "vercel_runtime", decision: "hold" },
      { ran: true, decision: "hold", pursue: [] },
      { ran: true, decision: "skip" },
    ]) {
      const rows = improvementsFromJev(jev);
      assert.deepEqual(rows, []);
    }
  });

  test("max 3 from pursue, evidence-only text", () => {
    const jev = {
      ran: true,
      decision: "pursue",
      pursue: [
        {
          metric: "sessions->add_to_cart",
          current: 80,
          severity: "p0",
          primary_step: "pdp_to_atc",
          jev: { severity: { choice: "p0" }, step: { choice: "pdp_to_atc" } },
        },
        {
          metric: "checkout_started->purchases",
          current: 12,
          jev: { severity: { choice: "p1" }, step: { choice: "checkout_to_purchase" } },
        },
        {
          metric: "add_to_cart->checkout_started",
          current: 9,
          jev: { severity: { choice: "p1" }, step: { choice: "atc_to_checkout" } },
        },
        {
          metric: "should-not-appear",
          current: 1,
          jev: { severity: { choice: "p1" }, step: { choice: "unclear" } },
        },
      ],
    };
    const rows = improvementsFromJev(jev);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].severity, "p0");
    assert.equal(rows[0].step, "pdp_to_atc");
    assert.match(rows[0].text, /P0/);
    assert.match(rows[0].text, /sessions->add_to_cart/);
    assert.match(rows[0].text, /80 sessions lost/);
    assert.equal(rows[2].rank, 3);
    assert.doesNotMatch(rows.map((r) => r.text).join(" "), /should-not-appear/);
  });

  test("skips pursue rows with no evidence (no fluff)", () => {
    assert.deepEqual(improvementsFromJev({
      ran: true,
      decision: "pursue",
      pursue: [{ notes: "please look" }, {}],
    }), []);
  });
});

describe("rates stay null when a count is missing", () => {
  test("does not invent a 100% leak", () => {
    const f = funnelFromCounts({
      sessions: 20, pdpSessions: null, addToCart: null,
      checkoutStarted: 4, purchases: 1,
    });
    assert.equal(f.rates.session_to_atc, null);
    assert.equal(f.pdp_sessions, null);
    assert.equal(f.rates.session_to_purchase, 0.05);
  });
});

describe("wiring", () => {
  const root = process.cwd();
  const route = readFileSync(
    path.join(root, "src/app/api/conversion-digest/route.ts"), "utf8",
  );
  const lib = readFileSync(
    path.join(root, "src/lib/conversion-digest.ts"), "utf8",
  );
  const miniEnv = readFileSync(path.join(root, "..", ".env.example"), "utf8");

  test("route is service-role, date-locked, and runs Jev on read", () => {
    assert.match(route, /getServerSupabase/);
    assert.match(route, /shopify_funnel_daily/);
    assert.match(route, /shopify_abandoned_checkouts/);
    assert.match(route, /shopify_funnel_status/);
    assert.match(route, /parseDigestDate/);
    assert.match(route, /buildConversionDigest/);
    assert.match(route, /ensureFunnelJevTriage/);
    assert.match(route, /isClosedEasternDay/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    assert.doesNotMatch(route, /orderCreate|draftOrderComplete|abandonedCheckoutUrl/);
    assert.doesNotMatch(route, /write_themes|unauthenticated_/);
    assert.doesNotMatch(route, /klaviyo|ryze|paid_ga_daily/i);
    assert.match(route, /phase2FromLockedDay/);
    assert.match(route, /ga4_landing_daily/);
    assert.doesNotMatch(route, /AI_GATEWAY_API_KEY/);
    assert.doesNotMatch(route, /shopify_orders/);
    assert.doesNotMatch(route, /api\/jev-funnel/);
  });

  test("lib never substitutes an older day and names the payload fields", () => {
    assert.match(lib, /Not substituting an older day/);
    assert.match(lib, /America\/New_York/);
    for (const field of [
      "as_of", "status", "funnel", "primary_leak", "abandons",
      "improvements", "definitions_note", "source",
      "sessions", "pdp_sessions", "add_to_cart", "checkout_started",
      "purchases", "open_count", "open_value", "top_products",
    ]) {
      assert.match(lib, new RegExp(field));
    }
    assert.doesNotMatch(lib, /ryze/i);
    assert.doesNotMatch(miniEnv, /AI_GATEWAY_API_KEY/);
  });
});
