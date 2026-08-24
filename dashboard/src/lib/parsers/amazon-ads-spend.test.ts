import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAmazonAdsSpendCsv, parseAmazonAdsSpendCsv } from "./amazon-ads-spend";

const SKU = `Start Date,End Date,MSKU,Child ASIN,Ordered Product Sales,Sponsored Products Ad Fee,Sponsored Brands Ad Fee
2025-04-01,2025-04-30,AA,B1,100,10.00,2.50
2025-04-01,2025-04-30,BB,B2,80,5,0
2025-03-01,2025-03-31,AA,B1,90,"$1,200.10",
`;

const LUMP = `Start Date,End Date,MSKU,Sponsored Products Ad Fee
2024-08-01,2025-07-31,AA,5000
`;

const CONSOLE = `Date,Campaign Name,Campaign ID,Spend,Clicks
2025-01-02,SP - Lip,111,12.00,4
2025-01-03,SP - Lip,111,8.50,2
`;

describe("Amazon ads spend CSV", () => {
  test("detects SKU Economics and Ads Console", () => {
    assert.equal(isAmazonAdsSpendCsv(SKU), true);
    assert.equal(isAmazonAdsSpendCsv(CONSOLE), true);
    assert.equal(isAmazonAdsSpendCsv("amazon-order-id,sku,item-price\n1,AA,10"), false);
  });

  test("sums ad fees by month", () => {
    const parsed = parseAmazonAdsSpendCsv(SKU);
    assert.equal(parsed.kind, "sku_economics");
    const apr = parsed.months.find((m) => m.period_start === "2025-04-01");
    const mar = parsed.months.find((m) => m.period_start === "2025-03-01");
    assert.equal(apr?.spend, 17.5);
    assert.equal(mar?.spend, 1200.1);
  });

  test("refuses a multi-month lump", () => {
    const parsed = parseAmazonAdsSpendCsv(LUMP);
    assert.equal(parsed.months.length, 0);
    assert.match(parsed.warnings[0] ?? "", /Monthly/);
  });

  test("real SKU Economics charge-total column, not Ad Fee", () => {
    const csv = [
      "Amazon store,Start date,End date,Parent ASIN,ASIN,MSKU,Sales,Sponsored Products charge per unit,Sponsored Products charge quantity,Sponsored Products charge total",
      "US,04/01/2026,04/30/2026,B0,B0,AA,20,1.5,10,818.26",
      "US,04/01/2026,04/30/2026,B0,B0,BB,10,1.4,5,3443.43",
    ].join("\n");
    const parsed = parseAmazonAdsSpendCsv(csv);
    assert.equal(parsed.kind, "sku_economics");
    assert.equal(parsed.months[0]?.period_start, "2026-04-01");
    assert.equal(parsed.months[0]?.spend, 4261.69);
  });

  test("Ads Console daily rolls to a month", () => {
    const parsed = parseAmazonAdsSpendCsv(CONSOLE);
    assert.equal(parsed.kind, "ads_console");
    assert.equal(parsed.months[0]?.spend, 20.5);
    assert.equal(parsed.daily.length, 2);
  });
});
