import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  awdOnHandUnits,
  fbaFulfillableUnits,
  fbaInboundUnits,
  fbaOnHandUnits,
  fbaReservedUnits,
  formatOwnedAsOf,
  latestOwnedSources,
  ownedAsOfLabel,
  ownedNetworkTotal,
  ownedNetworkTotalForSku,
  tplOnHandUnits,
} from "./inventory-owned-total";

const FBA_AT = "2026-08-27T10:30:00.000Z";
const TPL_AT = "2026-08-27T10:35:02.000Z";
const AWD_AT = "2026-08-27T10:30:01.000Z";

function completeRows() {
  return {
    fba: {
      sku: "DDPE0001Shop",
      fulfillable: 100,
      inbound_working: 20,
      inbound_shipped: 5,
      inbound_receiving: 5,
      reserved: 999,
      researching: 10,
      unfulfillable: 50,
      awd_inbound: 1000,
      snapshot_at: FBA_AT,
    },
    tpl: {
      sku: "DDPE0001Shop",
      available: 40,
      incoming: 200,
      pulled_at: TPL_AT,
    },
    awd: {
      sku: "DDPE0001Shop",
      awd_on_hand: 50,
      awd_inbound: 5000,
      awd_to_fba_in_transit: 300,
      pulled_at: AWD_AT,
    },
  };
}

describe("owned network Total", () => {
  test("same formula on every SKU: Total Amazon + 3PL", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.fbaFulfillable, 100);
    assert.equal(owned.fbaOnHand, 100);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.fbaResearching, 10);
    assert.equal(owned.fbaInbound, 30);
    assert.equal(owned.tplOnHand, 40);
    assert.equal(owned.awdOnHand, 50);
    assert.equal(owned.totalAmazon, 50 + 100 + 30 + 999 + 10);
    assert.equal(owned.total, owned.totalAmazon! + 40);
    assert.equal(owned.complete, true);
    assert.deepEqual(owned.missing, []);
    assert.equal(owned.asOf.fba, FBA_AT);
    assert.equal(owned.asOf.tpl, TPL_AT);
    assert.equal(owned.asOf.awd, AWD_AT);
    assert.equal(ownedAsOfLabel(owned), "2026-08-27");
    assert.match(formatOwnedAsOf(owned), /FBA 2026-08-27T10:30:00.000Z/);
  });

  test("adds SC reserved + researching; does not add unfulfillable, 3PL incoming, or AWD transit", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.totalAmazon, 100 + 999 + 30 + 10 + 50);
    assert.notEqual(owned.total, 100 + 30 + 40 + 50);
    assert.notEqual(owned.totalAmazon, 100 + 999 + 30 + 10 + 50 + 50);
    assert.notEqual(owned.total, 100 + 999 + 30 + 10 + 50 + 40 + 200);
    assert.notEqual(owned.total, 100 + 999 + 30 + 10 + 50 + 40 + 300);
  });
});

describe("Seller Central lock — 2026-08-27 10:30 UTC snapshot + restock splits", () => {
  const orangeFba = {
    sku: "DDPE0003Shop",
    fulfillable: 3_501,
    inbound_working: 0,
    inbound_shipped: 540,
    inbound_receiving: 0,
    reserved: 1_953,
    researching: 9,
    unfulfillable: 818,
    awd_inbound: 9_999,
    snapshot_at: FBA_AT,
  };
  const orangeRestock = {
    sku: "DDPE0003Shop",
    raw: {
      "Available": "3504",
      "FC transfer": "553",
      "FC Processing": "1324",
      "Customer Order": "74",
      "Unfulfillable": "818",
      "Inbound": "540",
    },
    pulled_at: FBA_AT,
  };
  const orangeTpl = { sku: "DDPE0003Shop", available: 6_426, pulled_at: TPL_AT };

  test("orange FBA 4054 / Total Amazon 6001 / Total 12427", () => {
    const owned = ownedNetworkTotal({
      sku: "DDPE0003Shop",
      fba: orangeFba,
      tpl: orangeTpl,
      restock: orangeRestock,
    });
    assert.equal(owned.fbaFulfillable, 3_501);
    assert.equal(owned.fbaOnHand, 4_054);
    assert.notEqual(owned.fbaOnHand, 3_501);
    assert.notEqual(owned.fbaOnHand, 6_819);
    assert.equal(owned.fbaReserved, 1_398);
    assert.notEqual(owned.fbaReserved, 1_953);
    assert.equal(owned.fbaResearching, 9);
    assert.equal(owned.fbaInbound, 540);
    assert.equal(owned.tplOnHand, 6_426);
    assert.equal(owned.awdOnHand, null);
    assert.equal(owned.totalAmazon, 4_054 + 540 + 1_398 + 9);
    assert.equal(owned.totalAmazon, 6_001);
    assert.equal(owned.totalAmazon, 6_819 - 818);
    assert.equal(owned.total, 6_001 + 6_426);
    assert.equal(owned.total, 12_427);
    assert.notEqual(owned.totalAmazon, 4_054 + 540 + 1_953 + 9);
    assert.notEqual(owned.total, 12_418);
    assert.notEqual(owned.total, 4_054 + 540 + 6_426);
    assert.notEqual(owned.totalAmazon, 6_819);
    assert.equal("fbaUnfulfillable" in owned, false);
  });

  test("peppermint FBA 2525 / Total Amazon 3410", () => {
    const owned = ownedNetworkTotal({
      sku: "DDPE0002Shop",
      fba: {
        sku: "DDPE0002Shop",
        fulfillable: 2_507,
        inbound_working: 0,
        inbound_shipped: 540,
        inbound_receiving: 97,
        reserved: 87,
        researching: 181,
        unfulfillable: 0,
        snapshot_at: FBA_AT,
      },
      restock: {
        sku: "DDPE0002Shop",
        raw: { "FC transfer": "18", "FC Processing": "18", "Customer Order": "49" },
        pulled_at: FBA_AT,
      },
    });
    assert.equal(owned.fbaOnHand, 2_525);
    assert.equal(owned.fbaInbound, 637);
    assert.equal(owned.fbaReserved, 67);
    assert.equal(owned.totalAmazon, 2_525 + 637 + 67 + 181);
    assert.equal(owned.totalAmazon, 3_410);
    assert.notEqual(owned.fbaOnHand, 3_410);
  });

  test("assorted FBA 3906 / Total Amazon 3967", () => {
    const owned = ownedNetworkTotal({
      sku: "DDPE0004Shop",
      fba: {
        sku: "DDPE0004Shop",
        fulfillable: 3_869,
        inbound_working: 0,
        inbound_shipped: 0,
        inbound_receiving: 0,
        reserved: 99,
        researching: 0,
        unfulfillable: 3,
        snapshot_at: FBA_AT,
      },
      restock: {
        sku: "DDPE0004Shop",
        raw: { "FC transfer": "37", "FC Processing": "17", "Customer Order": "44" },
        pulled_at: FBA_AT,
      },
    });
    assert.equal(owned.fbaOnHand, 3_906);
    assert.equal(owned.fbaReserved, 61);
    assert.equal(owned.fbaInbound, 0);
    assert.equal(owned.totalAmazon, 3_906 + 61);
    assert.equal(owned.totalAmazon, 3_967);
    assert.equal(owned.totalAmazon, 3_970 - 3);
    assert.notEqual(owned.fbaOnHand, 3_970);
  });

  test("non-lip SKU uses the identical formula — no family special case", () => {
    const deo = ownedNetworkTotal({
      sku: "DEO-LAVENDER-4OZ",
      fba: {
        sku: "DEO-LAVENDER-4OZ",
        fulfillable: 200,
        reserved: 80,
        inbound_working: 0,
        inbound_shipped: 10,
        inbound_receiving: 0,
        researching: 3,
        unfulfillable: 25,
        snapshot_at: FBA_AT,
      },
      restock: {
        sku: "DEO-LAVENDER-4OZ",
        raw: { "FC transfer": "20", "FC Processing": "10", "Customer Order": "50" },
      },
      tpl: { sku: "DEO-LAVENDER-4OZ", available: 100, pulled_at: TPL_AT },
      awd: { sku: "DEO-LAVENDER-4OZ", awd_on_hand: 0, pulled_at: AWD_AT },
    });
    assert.equal(deo.fbaFulfillable, 200);
    assert.equal(deo.fbaOnHand, 220);
    assert.equal(deo.fbaReserved, 60);
    assert.equal(deo.fbaInbound, 10);
    assert.equal(deo.fbaResearching, 3);
    assert.equal(deo.tplOnHand, 100);
    assert.equal(deo.awdOnHand, 0);
    assert.equal(deo.totalAmazon, 0 + 220 + 10 + 60 + 3);
    assert.equal(deo.total, 293 + 100);
    assert.notEqual(deo.totalAmazon, 220 + 80 + 10 + 3);
    assert.notEqual(deo.total, 293 + 100 + 25);
    assert.equal(deo.complete, true);
  });
});

describe("missing row is omitted, not required", () => {
  test("no-row AWD is blank and totals still sum the other sources", () => {
    const { fba, tpl } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", fba, tpl });
    assert.equal(owned.awdOnHand, null);
    assert.equal(owned.fbaOnHand, 100);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.fbaInbound, 30);
    assert.equal(owned.tplOnHand, 40);
    assert.equal(owned.totalAmazon, 100 + 999 + 30 + 10);
    assert.equal(owned.total, 100 + 999 + 30 + 10 + 40);
    assert.equal(owned.complete, false);
    assert.deepEqual(owned.missing, ["awd_on_hand"]);
    assert.equal(ownedAsOfLabel(owned), "2026-08-27");
    assert.match(formatOwnedAsOf(owned), /omitted awd_on_hand/);
  });

  test("missing 3PL is omitted; Total equals Total Amazon", () => {
    const { fba, awd } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", fba, awd, tpl: null });
    assert.equal(owned.tplOnHand, null);
    assert.equal(owned.totalAmazon, 100 + 999 + 30 + 10 + 50);
    assert.equal(owned.total, owned.totalAmazon);
    assert.equal(owned.complete, false);
    assert.deepEqual(owned.missing, ["tpl_on_hand"]);
    assert.equal(owned.fbaOnHand, 100);
    assert.equal(owned.awdOnHand, 50);
    assert.match(formatOwnedAsOf(owned), /omitted tpl_on_hand/);
  });

  test("missing FBA snapshot omits on-hand / inbound / reserved; Total still sums 3PL + AWD", () => {
    const { tpl, awd } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", tpl, awd });
    assert.equal(owned.fbaFulfillable, null);
    assert.equal(owned.fbaOnHand, null);
    assert.equal(owned.fbaReserved, null);
    assert.equal(owned.fbaInbound, null);
    assert.equal(owned.totalAmazon, 50);
    assert.equal(owned.total, 90);
    assert.deepEqual(owned.missing, [
      "fba_on_hand",
      "fba_reserved",
      "fba_inbound",
      "fba_researching",
    ]);
    assert.equal(fbaFulfillableUnits(null), null);
    assert.equal(fbaOnHandUnits(null), null);
    assert.equal(fbaReservedUnits(null), null);
    assert.equal(fbaInboundUnits(undefined), null);
    assert.equal(tplOnHandUnits(null), null);
    assert.equal(awdOnHandUnits(null), null);
  });

  test("0-row AWD shows 0 and counts as 0 in Total Amazon", () => {
    const rows = completeRows();
    rows.awd.awd_on_hand = 0;
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(owned.awdOnHand, 0);
    assert.equal(owned.totalAmazon, 100 + 999 + 30 + 10 + 0);
    assert.equal(owned.total, owned.totalAmazon! + 40);
    assert.equal(owned.complete, true);
  });

  test("known zero on a present FBA/3PL row is 0 and still completes Total", () => {
    const rows = completeRows();
    rows.tpl.available = 0;
    rows.fba.fulfillable = 0;
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(owned.tplOnHand, 0);
    assert.equal(owned.fbaOnHand, 0);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.totalAmazon, 0 + 999 + 30 + 10 + 50);
    assert.equal(owned.total, owned.totalAmazon! + 0);
    assert.equal(owned.complete, true);
  });

  test("FBA column is SC on-hand — not API fulfillable + reserved + unfulfillable", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.fbaOnHand, 100);
    assert.notEqual(owned.fbaOnHand, 100 + 999 + 10 + 50);
    assert.equal(owned.fbaReserved, 999);
  });

  test("reserved 0 on a present FBA row is 0; no FBA row omits reserved", () => {
    const rows = completeRows();
    rows.fba.reserved = 0;
    const zero = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(zero.fbaReserved, 0);
    assert.equal(zero.totalAmazon, 100 + 0 + 30 + 10 + 50);
    const missing = ownedNetworkTotal({ sku: "NO-FBA", tpl: rows.tpl, awd: rows.awd });
    assert.equal(missing.fbaReserved, null);
  });

  test("latest-per-SKU lookup does not invent a missing SKU as 0", () => {
    const sources = latestOwnedSources({
      snapshots: [completeRows().fba],
      tpl: [completeRows().tpl],
      awd: [completeRows().awd],
    });
    const other = ownedNetworkTotalForSku("MISSING-SKU", sources);
    assert.equal(other.total, null);
    assert.equal(other.totalAmazon, null);
    assert.equal(other.fbaOnHand, null);
    assert.equal(other.fbaReserved, null);
    assert.equal(other.fbaInbound, null);
    assert.equal(other.tplOnHand, null);
    assert.equal(other.awdOnHand, null);
  });
});

describe("AWD inbound is excluded from FBA inbound", () => {
  test("fbaInboundUnits ignores awd_inbound on the same object", () => {
    assert.equal(
      fbaInboundUnits({
        inbound_working: 10,
        inbound_shipped: 20,
        inbound_receiving: 4,
        awd_inbound: 9_999,
      }),
      34,
    );
  });

  test("Total Amazon uses AWD on-hand only, never awd_inbound", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.awdOnHand, 50);
    assert.equal(owned.fbaInbound, 30);
    assert.notEqual(owned.totalAmazon, 100 + 999 + 30 + 10 + 50 + 5000);
    assert.notEqual(owned.total, 100 + 999 + 30 + 10 + 50 + 40 + 1000);
  });
});

describe("latest-per-SKU including restock raw", () => {
  test("uses the newest snapshot / restock per SKU", () => {
    const sources = latestOwnedSources({
      snapshots: [
        {
          sku: "DDPE0003Shop",
          fulfillable: 1,
          inbound_working: 0,
          inbound_shipped: 0,
          inbound_receiving: 0,
          snapshot_at: "2026-08-01T00:00:00.000Z",
        },
        {
          sku: "DDPE0003Shop",
          fulfillable: 3_501,
          inbound_working: 0,
          inbound_shipped: 540,
          inbound_receiving: 0,
          reserved: 1_953,
          researching: 9,
          unfulfillable: 818,
          snapshot_at: FBA_AT,
        },
      ],
      tpl: [
        { sku: "DDPE0003Shop", available: 1, pulled_at: "2026-08-17T13:13:32.000Z" },
        { sku: "DDPE0003Shop", available: 6_426, pulled_at: TPL_AT },
      ],
      restock: [
        {
          sku: "DDPE0003Shop",
          raw: { "FC transfer": "1", "FC Processing": "1", "Customer Order": "1" },
          pulled_at: "2026-08-01T00:00:00.000Z",
        },
        {
          sku: "DDPE0003Shop",
          raw: { "FC transfer": "553", "FC Processing": "1324", "Customer Order": "74" },
          pulled_at: FBA_AT,
        },
      ],
    });
    const owned = ownedNetworkTotalForSku("DDPE0003Shop", sources);
    assert.equal(owned.fbaOnHand, 4_054);
    assert.equal(owned.totalAmazon, 6_001);
    assert.equal(owned.total, 12_427);
    assert.equal(owned.asOf.fba, FBA_AT);
    assert.equal(owned.asOf.tpl, TPL_AT);
  });
});
