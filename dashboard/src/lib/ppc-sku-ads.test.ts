import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { matchCampaignToSku, rollUpSkuAds, tokensOf } from "./ppc-sku-ads";

const catalog = [
  { sku: "TB-LIP-001", asin: "B0ABC12345", product_name: "Lip balm" },
  { sku: "TB-SOAP-2", asin: "B0DEF67890", product_name: "Soap" },
];

describe("campaign → SKU match is whole-token and unique", () => {
  test("exact SKU token hits", () => {
    const hit = matchCampaignToSku("SP | Exact | TB-LIP-001", catalog);
    assert.equal(hit?.sku, "TB-LIP-001");
  });

  test("exact ASIN token hits", () => {
    const hit = matchCampaignToSku("B0ABC12345 TOS", catalog);
    assert.equal(hit?.sku, "TB-LIP-001");
  });

  test("substring of a longer word does not match", () => {
    assert.equal(matchCampaignToSku("PRE-TB-LIP-001-X", catalog), null);
  });

  test("two catalog hits on one campaign is ambiguous → null", () => {
    const both = matchCampaignToSku("TB-LIP-001 and TB-SOAP-2", catalog);
    assert.equal(both, null);
  });

  test("tokens ignore punctuation", () => {
    assert.ok(tokensOf("SP / Exact / TB-LIP-001").includes("tb-lip-001"));
  });
});

describe("rollup never invents contribution", () => {
  test("unmatched campaign: spend/ACOS shown, contribution unavailable", () => {
    const { rows } = rollUpSkuAds(
      [{ campaign_name: "Auto discovery", campaign_type: "SP", spend: 80, sales: 100 }],
      catalog,
      { "TB-LIP-001": 50 },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].grain, "campaign");
    assert.equal(rows[0].contributionAvailable, false);
    assert.equal(rows[0].contribution, null);
    assert.equal(rows[0].acos, 80);
  });

  test("matched SKU without P&L row: contribution still unavailable", () => {
    const { rows } = rollUpSkuAds(
      [{ campaign_name: "TB-LIP-001 exact", campaign_type: "SP", spend: 40, sales: 200 }],
      catalog,
      {},
    );
    assert.equal(rows[0].grain, "sku");
    assert.equal(rows[0].sku, "TB-LIP-001");
    assert.equal(rows[0].contributionAvailable, false);
  });

  test("matched SKU with P&L row uses the stored figure, does not subtract ads", () => {
    const { rows } = rollUpSkuAds(
      [{ campaign_name: "TB-LIP-001 exact", campaign_type: "SP", spend: 40, sales: 200 }],
      catalog,
      { "TB-LIP-001": 125 },
    );
    assert.equal(rows[0].contribution, 125);
    assert.equal(rows[0].contributionAvailable, true);
    assert.equal(rows[0].spend, 40);
  });

  test("empty catalog → every row is a campaign, no invented SKU", () => {
    const { rows, matchedCampaigns } = rollUpSkuAds(
      [{ campaign_name: "TB-LIP-001", spend: 10, sales: 10 }],
      [],
      { "TB-LIP-001": 99 },
    );
    assert.equal(matchedCampaigns, 0);
    assert.equal(rows[0].grain, "campaign");
    assert.equal(rows[0].contributionAvailable, false);
  });
});

describe("SKU panel is read-only and honest about SB/SD", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const panel = readFileSync(path.join(process.cwd(), "src/components/ppc-sku-ads.tsx"), "utf8");

  test("the page mounts PpcSkuAds", () => {
    assert.match(page, /<PpcSkuAds days=\{rangeDays\} \/>/);
  });

  test("panel names the Amazon SB/SD limitation", () => {
    assert.match(panel, /SB\/SD have no search-term grain/);
    assert.match(panel, /unavailable/);
  });
});
