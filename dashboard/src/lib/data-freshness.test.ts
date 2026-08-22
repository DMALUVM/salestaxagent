import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarizeFreshness } from "./data-freshness";

describe("summarizeFreshness", () => {
  test("takes sales_daily max per channel and last ingest stamps", () => {
    const now = new Date("2026-08-22T18:00:00Z");
    const s = summarizeFreshness(
      [
        { sale_date: "2026-08-21", channel: "shopify" },
        { sale_date: "2026-08-21", channel: "amazon_spapi" },
        { sale_date: "2026-08-19", channel: "amazon_spapi" },
      ],
      [
        { ingested_at: "2026-08-22T06:00:00Z", file_type: "shopify_api" },
        { ingested_at: "2026-08-22T06:15:00Z", file_type: "amazon_spapi" },
      ],
      now,
    );
    assert.equal(s.shopifyMax, "2026-08-21");
    assert.equal(s.amazonMax, "2026-08-21");
    assert.equal(s.asOf, "2026-08-21");
    assert.equal(s.shopifyIngest, "2026-08-22T06:00:00Z");
    assert.equal(s.amazonIngest, "2026-08-22T06:15:00Z");
    assert.equal(s.stale, false);
  });

  test("marks missing or >36h sales as stale", () => {
    const now = new Date("2026-08-22T18:00:00Z");
    const s = summarizeFreshness(
      [{ sale_date: "2026-08-01", channel: "shopify" }],
      [],
      now,
    );
    assert.equal(s.shopifyStale, true);
    assert.equal(s.amazonStale, true);
    assert.equal(s.stale, true);
  });
});
