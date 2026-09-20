import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  emptyPhase2,
  phase2FromLockedDay,
  seoSection,
  topLandingDrops,
} from "./phase2-digest";

describe("Phase 2 extras are null until OAuth rows exist", () => {
  test("empty extras invent nothing", () => {
    const e = emptyPhase2();
    assert.equal(e.landing_drops, null);
    assert.equal(e.seo, null);
    assert.equal(e.connectors.ga4, false);
    assert.equal(e.connectors.gsc, false);
  });

  test("older GA4 / GSC days are not substituted", () => {
    const olderGa4 = [{
      metric_date: "2026-09-18", landing_page: "/old", device: "mobile",
      sessions: 80, purchase: 2,
    }];
    assert.equal(topLandingDrops(olderGa4, "2026-09-19"), null);
    const olderSeo = [{
      metric_date: "2026-09-17", query: "tallow balm", clicks: 9,
      impressions: 100, ctr: 0.09, position: 4,
    }];
    assert.equal(seoSection(olderSeo, [], "2026-09-19"), null);
    const extras = phase2FromLockedDay("2026-09-19", {
      ga4: olderGa4,
      gscQueries: olderSeo,
    });
    assert.equal(extras.landing_drops, null);
    assert.equal(extras.seo, null);
    assert.equal(extras.connectors.ga4, false);
    assert.equal(extras.connectors.gsc, false);
  });

  test("null purchases are skipped — no invented 100% leak", () => {
    const rows = [
      { metric_date: "2026-09-19", landing_page: "/a", device: "", sessions: 50, purchase: null },
      { metric_date: "2026-09-19", landing_page: "/b", device: "desktop", sessions: 40, purchase: 4 },
    ];
    const drops = topLandingDrops(rows, "2026-09-19");
    assert.ok(drops);
    assert.deepEqual(drops.map((d) => d.path), ["/b"]);
    assert.equal(drops[0].lost, 36);
  });

  test("locked-day GSC lists queries when present", () => {
    const q = [{
      metric_date: "2026-09-19", query: "tallow", clicks: 3,
      impressions: 40, ctr: 0.075, position: 8.2,
    }];
    const seo = seoSection(q, [], "2026-09-19");
    assert.ok(seo);
    assert.equal(seo.queries[0].key, "tallow");
    assert.equal(seo.pages.length, 0);
  });
});

describe("wiring — extras hang on the landed digest", () => {
  const root = process.cwd();
  const route = readFileSync(path.join(root, "src/app/api/conversion-digest/route.ts"), "utf8");
  const lib = readFileSync(path.join(root, "src/lib/conversion-digest.ts"), "utf8");

  test("does not replace Iris fields or add a second Jev route", () => {
    assert.match(route, /buildConversionDigest/);
    assert.match(route, /ensureFunnelJevTriage/);
    assert.match(route, /phase2FromLockedDay/);
    assert.match(route, /emptyPhase2/);
    assert.doesNotMatch(route, /api\/jev-funnel/);
    assert.doesNotMatch(lib, /ga4_landing_daily|gsc_query_daily/);
    assert.doesNotMatch(route, /paid_ga_daily|ryze/i);
  });
});
