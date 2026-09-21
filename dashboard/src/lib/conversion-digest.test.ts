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
  improvementContractErrors,
  improvementFromAction,
  improvementsFromJev,
  improvementsFromLockedDay,
  isBlairThemeBugPath,
  ownerForAction,
  parseDigestDate,
} from "./conversion-digest";
import { emptyPhase2, type Phase2Digest } from "./phase2-digest";
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
    assert.equal(d.improvements.length, 1);
    assert.equal(d.improvements[0].owner, "Harry");
    assert.equal(d.improvements[0].dave_tap, false);
    assert.deepEqual(improvementContractErrors(d.improvements[0]), []);
    assert.match(d.improvements[0].text, /sessions→add_to_cart/);
    assert.match(d.improvements[0].text, /75 sessions lost/);
    assert.match(d.improvements[0].text, /\[Harry\]/);
    assert.doesNotMatch(d.improvements[0].text, /\[Kit\]/);
    assert.doesNotMatch(d.improvements[0].text, /fix PDP\/ATC/);
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
    assert.equal(rows[0].owner, "Harry");
    assert.equal(rows[0].severity, "P0");
    assert.equal(rows[0].step, "pdp_to_atc");
    assert.match(rows[0].text, /sessions→add_to_cart/);
    assert.match(rows[0].text, /80 sessions lost/);
    assert.match(rows[0].text, /\[Harry\]/);
    assert.doesNotMatch(rows[0].text, /fix PDP\/ATC/);
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

function phase2Of(partial: Partial<Phase2Digest> = {}): Phase2Digest {
  return { ...emptyPhase2(), ...partial };
}

describe("improvements from locked-day actions", () => {
  test("schema + ban-list: one owner, evidence, ask, dave_tap", () => {
    const landing = improvementFromAction({
      mode: "landing", period: "2026-09-19",
      path: "/products/natural-tallow-deodorant-extra-strength",
      device: "mobile", current: 66, sessions: 66, purchases: 0,
      severity: "p1", step: "pdp_to_atc",
    });
    assert.equal(
      landing?.concrete_ask,
      "Mobile /products/natural-tallow-deodorant-extra-strength: 66 sessions → 0 purchases — rewrite above-fold CTA to Extra Strength benefit + simplify ATC [Harry]",
    );
    assert.equal(landing?.owner, "Harry");
    assert.equal(landing?.severity, "P1");
    assert.equal(landing?.dave_tap, false);
    assert.equal(landing?.evidence.source, "ga4");
    assert.equal(landing?.evidence.path, "/products/natural-tallow-deodorant-extra-strength");
    assert.equal(landing?.evidence.device, "mobile");
    assert.equal(landing?.evidence.sessions, 66);
    assert.equal(landing?.evidence.purchases, 0);
    assert.deepEqual(improvementContractErrors(landing!), []);
    assert.equal(ownerForAction({
      mode: "landing", path: "/products/natural-tallow-deodorant-extra-strength",
    }), "Harry");

    const collection = improvementFromAction({
      mode: "landing", path: "/collections/all", device: "mobile",
      current: 40, sessions: 40, purchases: 1, severity: "p1",
    });
    assert.equal(collection?.owner, "Harry");
    assert.doesNotMatch(collection?.text ?? "", /\[Blair\]/);
    assert.equal(isBlairThemeBugPath("/collections/all"), false);
    assert.equal(isBlairThemeBugPath("/checkouts/cn"), true);
    assert.equal(ownerForAction({ mode: "landing", path: "/checkouts/cn" }), "Blair");

    const gsc = improvementFromAction({
      mode: "seo", period: "2026-09-19", query: "tallow balm",
      impressions: 80, clicks: 0, position: 12, severity: "p1", step: "unclear",
    });
    assert.equal(gsc?.owner, "Nora");
    assert.equal(gsc?.dave_tap, false);
    assert.equal(gsc?.evidence.query, "tallow balm");
    assert.equal(gsc?.evidence.impressions, 80);
    assert.equal(gsc?.evidence.clicks, 0);
    assert.equal(gsc?.evidence.position, 12);
    assert.match(gsc?.concrete_ask ?? "", /GSC query 'tallow balm': 80 impr \/ 0 clicks \/ pos 12/);
    assert.match(gsc?.concrete_ask ?? "", /\[Nora\]$/);
    assert.deepEqual(improvementContractErrors(gsc!), []);

    const gscNoPos = improvementFromAction({
      mode: "seo", query: "tallow", impressions: 90, clicks: 0, severity: "p1",
    });
    assert.doesNotMatch(gscNoPos?.text ?? "", /pos /);
    assert.equal(gscNoPos?.evidence.position, undefined);

    const ads = improvementFromAction({
      mode: "ads", period: "2026-09-19", campaign: "AI MAX Search V1",
      spend: 15.19, conversions: 0, severity: "p1", step: "unclear",
    });
    assert.equal(
      ads?.concrete_ask,
      "Ads AI MAX Search V1: $15.19 / 0 conv — review negatives or pause [Blake]",
    );
    assert.equal(ads?.owner, "Blake");
    assert.equal(ads?.dave_tap, false);
    assert.equal(ads?.evidence.campaign, "AI MAX Search V1");
    assert.equal(ads?.evidence.spend, 15.19);
    assert.equal(ads?.evidence.conversions, 0);
    assert.deepEqual(improvementContractErrors(ads!), []);

    const adsMoney = improvementFromAction({
      mode: "ads", campaign: "AI MAX Search V1",
      spend: 80, conversions: 0, severity: "p1",
    });
    assert.equal(adsMoney?.dave_tap, true);

    assert.equal(improvementFromAction({
      mode: "landing", path: "", current: 66, severity: "p1",
    }), null);
    assert.equal(improvementFromAction({
      mode: "seo", query: "x", impressions: 80, clicks: null, severity: "p1",
    }), null);
    assert.equal(improvementFromAction({
      mode: "ads", campaign: "Brand", spend: 40, conversions: null, severity: "p1",
    }), null);

    const page = improvementFromAction({
      mode: "seo", metric: "gsc_page", query: "/products/tallow-balm",
      impressions: 80, clicks: 0, position: 18, severity: "p1",
    });
    assert.equal(page?.owner, "Nora");
    assert.equal(page?.evidence.page, "/products/tallow-balm");
    assert.match(page?.concrete_ask ?? "", /GSC page \/products\/tallow-balm: 80 impr \/ 0 clicks \/ pos 18/);

    const lostOnly = improvementFromAction({
      mode: "landing", path: "/products/x", device: "mobile",
      current: 66, severity: "p1",
    });
    assert.match(lostOnly?.text ?? "", /Mobile \/products\/x: 66 lost sessions/);
    assert.doesNotMatch(lostOnly?.text ?? "", /→ 0 purchases/);
    assert.equal(lostOnly?.evidence.purchases, undefined);
  });

  test("Shopify leak is Harry; abandon $ spike is Kit only", () => {
    const leak = improvementFromAction({
      mode: "leak", metric: "sessions->add_to_cart", current: 75,
      delta_pct: 0.75, step: "pdp_to_atc", severity: "p0",
    });
    assert.equal(leak?.owner, "Harry");
    assert.equal(leak?.severity, "P0");
    assert.equal(leak?.dave_tap, false);
    assert.match(leak?.concrete_ask ?? "", /Shopify sessions→add_to_cart: 75 sessions lost \(75%\)/);
    assert.match(leak?.concrete_ask ?? "", /\[Harry\]$/);
    assert.doesNotMatch(leak?.text ?? "", /\[Kit\]/);
    assert.deepEqual(improvementContractErrors(leak!), []);

    const checkout = improvementFromAction({
      mode: "leak", metric: "checkout_started->purchases", current: 12,
      step: "checkout_to_purchase", severity: "p1",
    });
    assert.equal(checkout?.owner, "Blair");
    assert.match(checkout?.concrete_ask ?? "", /\[Blair\]$/);

    const kit = improvementFromAction({
      mode: "abandon", abandon_value: 90, abandon_count: 1, severity: "p0",
    });
    assert.equal(kit?.owner, "Kit");
    assert.equal(kit?.dave_tap, true);
    assert.equal(
      kit?.concrete_ask,
      "Shopify abandons: $90.00 open / 1 checkout — send recover sequence [Kit]",
    );
    assert.deepEqual(improvementContractErrors(kit!), []);

    const fromDay = improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: daily(),
      abandons: [abandon({ total_price: 90 })],
    });
    const owners = fromDay.map((r) => r.owner);
    assert.ok(owners.includes("Harry"));
    assert.ok(owners.includes("Kit"));
    assert.equal(fromDay.filter((r) => r.owner === "Kit").length, 1);
    assert.equal(fromDay.every((r) => improvementContractErrors(r).length === 0), true);
    const kitRow = fromDay.find((r) => r.owner === "Kit");
    assert.match(kitRow?.text ?? "", /\$90\.00 open/);
    assert.doesNotMatch(fromDay.map((r) => r.text).join(" "), /\[Harry\] \[Kit\]/);
  });

  test("ban-list rejects generic fix PDP/ATC and multi-owner", () => {
    const ok = improvementFromAction({
      mode: "landing", path: "/products/tallow-balm", device: "mobile",
      current: 66, sessions: 66, purchases: 0, severity: "p1",
    });
    assert.doesNotMatch(ok?.concrete_ask ?? "", /fix PDP\/ATC/i);
    assert.deepEqual(improvementContractErrors(ok!), []);
    assert.deepEqual(improvementContractErrors({
      rank: 1,
      text: "P1 · landing /products/x · 66 lost — fix PDP/ATC [Harry]",
      owner: "Harry",
      severity: "P1",
      evidence: { source: "ga4", path: "/products/x", lost: 66 },
      concrete_ask: "fix PDP/ATC [Harry]",
      dave_tap: false,
      step: "pdp_to_atc",
    }), ["ban"]);
    assert.ok(improvementContractErrors({
      rank: 1,
      text: "leak [Harry] [Kit]",
      owner: "Harry",
      severity: "P1",
      evidence: { source: "shopify", lost: 75 },
      concrete_ask: "do both [Harry] [Kit]",
      dave_tap: false,
      step: "pdp_to_atc",
    }).includes("multi_owner"));
  });

  test("empty when no material as_of rows", () => {
    const quiet = daily({
      sessions: 12, pdp_sessions: 8, add_to_cart: 10,
      checkout_started: 8, purchases: 6,
    });
    assert.deepEqual(improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: quiet,
      jev: { ran: true, decision: "hold" },
      phase2: emptyPhase2(),
    }), []);
    const onlyUnnamed = improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: quiet,
      phase2: phase2Of({
        landing_drops: [{ path: "", device: "mobile", sessions: 70, purchases: 4, lost: 66, rate: 0.94 }],
        seo: { queries: [{ key: "", clicks: 0, impressions: 200, ctr: 0, position: 20 }], pages: [] },
        ads: [{ campaign_id: "", campaign_name: "", spend: 40, clicks: 10, conversions: 0 }],
      }),
    });
    assert.deepEqual(onlyUnnamed, []);
  });

  test("day-lock: GAP / missing daily row stays empty even with Jev pursue", () => {
    const d = buildConversionDigest({
      asOf: "2026-09-19",
      now: NOW,
      dailyRow: null,
      funnelOk: true,
      abandons: [],
      jev: { ran: true, decision: "pursue", pursue: [{ metric: "sessions->add_to_cart", current: 80, severity: "p0" }] },
      phase2: phase2Of({
        landing_drops: [{ path: "/products/x", device: "mobile", sessions: 70, purchases: 4, lost: 66, rate: 0.94 }],
      }),
    });
    assert.equal(d.status, "GAP");
    assert.deepEqual(d.improvements, []);
  });

  test("Jev hold still emits as_of Shopify + GA4/GSC/Ads when material", () => {
    const d = buildConversionDigest({
      asOf: "2026-09-19",
      now: NOW,
      dailyRow: daily(),
      funnelOk: true,
      abandons: [],
      jev: { ran: true, decision: "hold", pursue: [] },
      phase2: phase2Of({
        landing_drops: [{
          path: "/products/tallow-balm", device: "mobile",
          sessions: 70, purchases: 4, lost: 66, rate: 0.9429,
        }],
        seo: {
          queries: [{ key: "tallow balm", clicks: 0, impressions: 120, ctr: 0, position: 22 }],
          pages: [],
        },
        ads: [{
          campaign_id: "99", campaign_name: "Brand Search",
          spend: 42, clicks: 18, conversions: 0,
        }],
      }),
    });
    assert.equal(d.status, "CLEAR");
    assert.ok(d.improvements.length >= 3);
    assert.ok(d.improvements.length <= 5);
    const texts = d.improvements.map((r) => r.text).join("\n");
    assert.equal(d.improvements.every((r) => improvementContractErrors(r).length === 0), true);
    assert.match(texts, /sessions→add_to_cart/);
    assert.match(texts, /75 sessions lost/);
    assert.match(texts, /\[Harry\]/);
    assert.match(texts, /Mobile \/products\/tallow-balm: 70 sessions → 4 purchases/);
    assert.match(texts, /rewrite above-fold CTA to Tallow Balm benefit \+ simplify ATC \[Harry\]/);
    assert.match(texts, /GSC query 'tallow balm': 120 impr \/ 0 clicks \/ pos 22/);
    assert.match(texts, /\[Nora\]/);
    assert.match(texts, /Ads Brand Search: \$42\.00 \/ 18 clicks \/ 0 conv — review negatives or pause \[Blake\]/);
    assert.doesNotMatch(texts, /fix PDP\/ATC/);
    assert.doesNotMatch(texts, /\bMeta\b|meta_ads|\[Meta\]/);
    assert.equal(new Set(d.improvements.map((r) => r.owner)).has("Harry"), true);
    assert.equal(d.improvements.find((r) => r.owner === "Blake")?.dave_tap, false);
    assert.equal(d.improvements[0].rank, 1);
    assert.equal(d.improvements.at(-1)?.rank, d.improvements.length);
  });

  test("Jev pursue overlays severity only — never 7d last_stats lost counts", () => {
    const rows = improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: daily(),
      jev: {
        ran: true,
        decision: "pursue",
        pursue: [{
          metric: "sessions->add_to_cart",
          current: 800,
          severity: "p0",
          primary_step: "pdp_to_atc",
          jev: { severity: { choice: "p0" }, step: { choice: "pdp_to_atc" } },
        }],
      },
    });
    assert.equal(rows[0].severity, "P0");
    assert.equal(rows[0].step, "pdp_to_atc");
    assert.equal(rows[0].owner, "Harry");
    assert.match(rows[0].text, /75 sessions lost/);
    assert.match(rows[0].text, /\[Harry\]/);
    assert.doesNotMatch(rows[0].text, /800/);
    assert.deepEqual(improvementContractErrors(rows[0]), []);
  });

  test("max 5 ranked items and empty when phase2 sections are null", () => {
    const drops = Array.from({ length: 6 }, (_, i) => ({
      path: `/products/sku-${i}`, device: "mobile",
      sessions: 80 - i, purchases: 2, lost: 70 - i, rate: 0.9,
    }));
    const queries = Array.from({ length: 6 }, (_, i) => ({
      key: `query ${i}`, clicks: 0, impressions: 200 - i * 10, ctr: 0, position: 20,
    }));
    const ads = Array.from({ length: 6 }, (_, i) => ({
      campaign_id: String(i), campaign_name: `Camp ${i}`,
      spend: 80 - i, clicks: 20, conversions: 0,
    }));
    const rows = improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: daily(),
      phase2: phase2Of({
        landing_drops: drops,
        seo: { queries, pages: [] },
        ads,
      }),
    });
    assert.ok(rows.length <= 5);
    assert.equal(rows.length, 5);
    assert.equal(rows.every((r) => improvementContractErrors(r).length === 0), true);
    assert.equal(rows.every((r) => !/fix PDP\/ATC/i.test(r.concrete_ask)), true);
    assert.deepEqual(improvementsFromLockedDay({
      asOf: "2026-09-19",
      dailyRow: daily({ sessions: 8, add_to_cart: 7, checkout_started: 6, purchases: 5 }),
      phase2: emptyPhase2(),
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
    assert.match(route, /campaign_name/);
    assert.match(route, /phase2/);
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
