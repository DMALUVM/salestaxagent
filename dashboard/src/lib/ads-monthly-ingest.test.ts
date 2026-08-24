import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAmazonAdsSpendCsv } from "./parsers/amazon-ads-spend";

const SKU = `Amazon store,Start date,End date,Parent ASIN,ASIN,MSKU,Sales,Sponsored Products charge per unit,Sponsored Products charge quantity,Sponsored Products charge total
US,03/01/2026,03/31/2026,B0,B0,AA,100,1.5,10,818.26
`;

describe("ads monthly ingest helpers", () => {
  test("parse path matches SKU Economics charge total", () => {
    const parsed = parseAmazonAdsSpendCsv(SKU);
    assert.equal(parsed.kind, "sku_economics");
    assert.equal(parsed.months[0]?.spend, 818.26);
    assert.equal(parsed.months[0]?.period_start, "2026-03-01");
  });
});
