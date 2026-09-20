import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import {
  bucketItem,
  ensureFunnelJevTriage,
  evaluateViaGateway,
  hasGatewayKey,
  jevAlreadyRan,
  jevDecisionFromResult,
  jevItemsFromStats,
  runFunnelJevTriage,
  shouldRunJev,
  statsAreSilent,
} from "./funnel-jev-triage";

const stats = {
  leak: { from: "sessions", to: "add_to_cart", lost: 80, rate: 0.8 },
  abandon: { open: 3, openValue: 90 },
  window: { end: "2026-09-19" },
};

describe("funnel Jev protocol", () => {
  test("wraps leak + abandon as items", () => {
    const items = jevItemsFromStats(stats);
    assert.equal(items.length, 1);
    assert.equal(items[0].mode, "leak");
    assert.equal(items[0].period, "2026-09-19");
    assert.equal(items[0].metric, "sessions->add_to_cart");
    assert.equal(items[0].current, 80);
    assert.equal(items[0].abandon_count, 3);
    assert.equal(items[0].abandon_value, 90);
  });

  test("decision map: pursue / hold / skip / fail closed", () => {
    assert.equal(jevDecisionFromResult({ pursue: [1], hold: [], skip: [], errors: [] }), "pursue");
    assert.equal(jevDecisionFromResult({ pursue: [], hold: [1], skip: [], errors: [] }), "hold");
    assert.equal(jevDecisionFromResult({ pursue: [], hold: [], skip: [1], errors: [1] }), "hold");
    assert.equal(jevDecisionFromResult({ pursue: [], hold: [], skip: [1], errors: [] }), "skip");
    assert.equal(jevDecisionFromResult({}), "hold");
    assert.equal(jevDecisionFromResult({ pursue: [1], hold: [1], errors: [1] }), "pursue");
  });

  test("bucketItem matches the Python pilot", () => {
    assert.equal(bucketItem(stats as never, { severity: { choice: "p0" } }), "pursue");
    assert.equal(bucketItem(stats as never, {
      severity: { choice: "p1" }, needs_dave: { probability: 0.9 },
    }), "pursue");
    assert.equal(bucketItem(stats as never, {
      severity: { choice: "p2" }, needs_dave: { probability: 0.1 },
    }), "skip");
    assert.equal(bucketItem(stats as never, { severity: { choice: "p1" } }), "hold");
  });
});

describe("fail closed on Vercel", () => {
  test("silent → no evaluate", async () => {
    let called = 0;
    const out = await runFunnelJevTriage({
      stats: { ...stats, silent: true },
      hasGatewayKey: true,
      evaluate: async () => {
        called += 1;
        return { answers: { severity: { choice: "p0" } } };
      },
    });
    assert.equal(called, 0);
    assert.equal(out.ran, false);
    assert.equal(out.reason, "silent");
    assert.equal(out.decision, null);
  });

  test("missing AI_GATEWAY_API_KEY → hold_for_review, no LLM", async () => {
    let called = 0;
    const out = await runFunnelJevTriage({
      stats,
      hasGatewayKey: false,
      evaluate: async () => {
        called += 1;
        return { answers: { severity: { choice: "p0" } } };
      },
    });
    assert.equal(called, 0);
    assert.equal(out.ran, false);
    assert.equal(out.decision, "hold");
    assert.equal(out.severity, "hold_for_review");
    assert.equal(out.reason, "missing_gateway_key");
    assert.equal(out.runtime, "vercel");
  });

  test("no stats → hold_for_review", async () => {
    const out = await runFunnelJevTriage({ stats: null, hasGatewayKey: true });
    assert.equal(out.reason, "no_stats");
    assert.equal(out.decision, "hold");
  });

  test("evaluate p0 → pursue", async () => {
    const out = await runFunnelJevTriage({
      stats,
      hasGatewayKey: true,
      evaluate: async () => ({ answers: { severity: { choice: "p0" } } }),
    });
    assert.equal(out.ran, true);
    assert.equal(out.decision, "pursue");
    assert.equal(out.pursue_n, 1);
    assert.equal((out.pursue ?? []).length, 1);
  });

  test("evaluate throw → hold", async () => {
    const out = await runFunnelJevTriage({
      stats,
      hasGatewayKey: true,
      evaluate: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(out.decision, "hold");
    assert.equal(out.severity, "hold_for_review");
    assert.equal(out.error_n, 1);
  });

  test("hasGatewayKey reads AI_GATEWAY_API_KEY only", () => {
    assert.equal(hasGatewayKey({}), false);
    assert.equal(hasGatewayKey({ AI_GATEWAY_API_KEY: "   " }), false);
    assert.equal(hasGatewayKey({ AI_GATEWAY_API_KEY: "x" }), true);
  });

  test("statsAreSilent reads Mini stamp", () => {
    assert.equal(statsAreSilent({ silent: true }), true);
    assert.equal(statsAreSilent({ jev: { reason: "silent" } }), true);
    assert.equal(statsAreSilent(stats), false);
  });

  test("shouldRunJev skips silent and already-ran Vercel results", () => {
    assert.equal(shouldRunJev(null), false);
    assert.equal(shouldRunJev({ ...stats, silent: true }), false);
    assert.equal(shouldRunJev({
      ...stats,
      jev: { ran: true, runtime: "vercel", decision: "pursue" },
    }), false);
    assert.equal(shouldRunJev({
      ...stats,
      jev: { ran: false, reason: "vercel_runtime", runtime: "vercel" },
    }), true);
    assert.equal(shouldRunJev({
      ...stats,
      jev: { ran: true, runtime: "vercel" },
    }, true), true);
    assert.equal(jevAlreadyRan({ jev: { ran: true, runtime: "vercel" } }), true);
  });

  test("ensureFunnelJevTriage reuses persisted pursue and persists a new run", async () => {
    const reused = await ensureFunnelJevTriage({
      stats: {
        ...stats,
        jev: {
          ran: true, runtime: "vercel", decision: "pursue",
          pursue: [{ metric: "sessions->add_to_cart", current: 80, severity: "p0" }],
        },
      },
      hasGatewayKey: true,
      evaluate: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(reused.reason, "already_ran");
    assert.equal(reused.decision, "pursue");
    assert.equal((reused.pursue ?? []).length, 1);

    let persisted = 0;
    const ran = await ensureFunnelJevTriage({
      stats: { ...stats, jev: { ran: false, reason: "vercel_runtime" } },
      hasGatewayKey: true,
      evaluate: async () => ({ answers: { severity: { choice: "p0" } } }),
      persist: async (merged, result) => {
        persisted += 1;
        assert.equal(result.decision, "pursue");
        assert.equal((merged.jev as { ran?: boolean }).ran, true);
      },
    });
    assert.equal(ran.ran, true);
    assert.equal(ran.decision, "pursue");
    assert.equal(persisted, 1);

    const closed = await ensureFunnelJevTriage({
      stats: { ...stats, jev: { ran: false, reason: "vercel_runtime" } },
      hasGatewayKey: false,
      evaluate: async () => ({ answers: { severity: { choice: "p0" } } }),
    });
    assert.equal(closed.ran, false);
    assert.equal(closed.reason, "missing_gateway_key");
    assert.deepEqual(closed.pursue, undefined);
  });

  test("evaluateViaGateway fails closed without key and redacts it", async () => {
    const prev = process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    await assert.rejects(
      () => evaluateViaGateway("state", {} as never),
      /AI_GATEWAY_API_KEY not available/,
    );
    process.env.AI_GATEWAY_API_KEY = "super-secret-key";
    await assert.rejects(
      () => evaluateViaGateway("state", {} as never, (async () =>
        new Response("leak super-secret-key", { status: 500 })
      ) as typeof fetch),
      (err: Error) => {
        assert.match(err.message, /jev gateway 500/);
        assert.doesNotMatch(err.message, /super-secret-key/);
        assert.match(err.message, /REDACTED/);
        return true;
      },
    );
    if (prev === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prev;
  });
});

describe("wiring", () => {
  const root = process.cwd();
  const route = readFileSync(
    path.join(root, "src/app/api/shopify-funnel/jev-triage/route.ts"),
    "utf8",
  );
  const mw = readFileSync(path.join(root, "src/middleware.ts"), "utf8");
  const envMd = readFileSync(path.join(root, "ENV.md"), "utf8");
  const vercel = readFileSync(path.join(root, "vercel.json"), "utf8");
  const miniEnv = readFileSync(path.join(root, "..", ".env.example"), "utf8");

  test("route is service-role, no Shopify writes, fail-closed", () => {
    assert.match(route, /getServerSupabase/);
    assert.match(route, /shopify_funnel_status/);
    assert.match(route, /AI_GATEWAY_API_KEY/);
    assert.match(route, /holdClosed/);
    assert.match(route, /ensureFunnelJevTriage/);
    assert.doesNotMatch(route, /orderCreate|draftOrderComplete|abandonedCheckoutUrl/);
    assert.doesNotMatch(route, /write_themes|unauthenticated_/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_AI_GATEWAY/);
    assert.doesNotMatch(route, /shopify_orders/);
    assert.match(route, /Never writes theme/);
  });

  test("middleware cron bearer is jev-triage only", () => {
    assert.match(mw, /\/api\/shopify-funnel\/jev-triage/);
    assert.match(mw, /CRON_SECRET/);
    assert.match(mw, /Bearer/);
    assert.equal(
      (mw.match(/\/api\/shopify-funnel\/jev-triage/g) || []).length >= 1,
      true,
    );
  });

  test("docs keep the key off Mini and off the repo", () => {
    assert.match(envMd, /AI_GATEWAY_API_KEY/);
    assert.match(envMd, /Do not set on Mini/);
    assert.match(envMd, /Secure Vault/);
    assert.match(envMd, /conversion-digest/);
    assert.doesNotMatch(miniEnv, /AI_GATEWAY_API_KEY/);
    assert.match(vercel, /shopify-funnel\/jev-triage/);
  });

  test("dynamic config reads stay turbopackIgnore", () => {
    for (const rel of [
      "src/lib/registration-plan.ts",
      "src/lib/ads-roles.ts",
      "src/lib/ads-strategy-settings.ts",
      "src/lib/brand-terms.ts",
    ]) {
      const src = readFileSync(path.join(root, rel), "utf8");
      assert.match(src, /turbopackIgnore: true/);
    }
  });
});
