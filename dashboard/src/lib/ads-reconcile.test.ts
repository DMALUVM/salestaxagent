import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReconcile } from "./ads-reconcile";

describe("buildDailyReconcile", () => {
  test("flags partial day when SP only but SB exists on other days", () => {
    const rows = [
      { date: "2026-08-22", campaign_type: "SP", spend: 400, clicks: 260 },
      { date: "2026-08-22", campaign_type: "SB", spend: 36, clicks: 24 },
      { date: "2026-08-23", campaign_type: "SP", spend: 411.3, clicks: 271 },
    ];
    const summary = buildDailyReconcile(rows, "2026-08-23", 2);
    assert.ok(summary);
    const aug22 = summary!.days.find((d) => d.date === "2026-08-22");
    const aug23 = summary!.days.find((d) => d.date === "2026-08-23");
    assert.equal(aug22?.partialSync, false);
    assert.equal(aug23?.partialSync, true);
    assert.equal(aug23?.productsMissing.join("/"), "SB/SD");
    assert.equal(summary!.partialDayCount, 1);
  });

  test("does not flag missing SB when account never has SB in window", () => {
    const rows = [
      { date: "2026-08-22", campaign_type: "SP", spend: 400, clicks: 260 },
      { date: "2026-08-23", campaign_type: "SP", spend: 411, clicks: 271 },
    ];
    const summary = buildDailyReconcile(rows, "2026-08-23", 2);
    assert.equal(summary!.days[1].partialSync, false);
  });

  test("computes CPC and ROAS from totals", () => {
    const rows = [
      { date: "2026-08-23", campaign_type: "SP", spend: 100, clicks: 50,
        sales_14d: 173, impressions: 10000 },
    ];
    const day = buildDailyReconcile(rows, "2026-08-23", 1)!.days[0];
    assert.equal(day.cpc, 2);
    assert.equal(day.roas, 1.73);
    assert.equal(day.ctr, 0.5);
  });
});
