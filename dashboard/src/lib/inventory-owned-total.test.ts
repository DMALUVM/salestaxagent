import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  awdOnHandUnits,
  fbaFulfillableUnits,
  fbaInboundUnits,
  fbaReservedUnits,
  formatOwnedAsOf,
  latestOwnedSources,
  ownedAsOfLabel,
  ownedNetworkTotal,
  ownedNetworkTotalForSku,
  tplOnHandUnits,
} from "./inventory-owned-total";

const FBA_AT = "2026-08-26T18:00:00.000Z";
const TPL_AT = "2026-08-26T10:35:01.000Z";
const AWD_AT = "2026-08-25T12:00:00.000Z";

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
  test("same formula on every SKU: fulfillable + reserved + inbound + 3PL + AWD", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.fbaFulfillable, 100);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.fbaInbound, 30);
    assert.equal(owned.tplOnHand, 40);
    assert.equal(owned.awdOnHand, 50);
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 50);
    assert.equal(owned.complete, true);
    assert.deepEqual(owned.missing, []);
    assert.equal(owned.asOf.fba, FBA_AT);
    assert.equal(owned.asOf.tpl, TPL_AT);
    assert.equal(owned.asOf.awd, AWD_AT);
    assert.equal(ownedAsOfLabel(owned), "2026-08-25");
    assert.match(formatOwnedAsOf(owned), /FBA 2026-08-26T18:00:00.000Z/);
    assert.match(formatOwnedAsOf(owned), /3PL 2026-08-26T10:35:01.000Z/);
    assert.match(formatOwnedAsOf(owned), /AWD 2026-08-25T12:00:00.000Z/);
  });

  test("adds reserved; does not add unfulfillable, researching, 3PL incoming, or AWD transit", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 50);
    assert.notEqual(owned.total, 100 + 30 + 40 + 50);
    assert.notEqual(owned.total, 100 + 999 + 30 + 40 + 50 + 10 + 50);
    assert.notEqual(owned.total, 100 + 999 + 30 + 40 + 50 + 200);
    assert.notEqual(owned.total, 100 + 999 + 30 + 40 + 50 + 300);
  });
});

describe("Seller Central lock numbers — same math, any SKU", () => {
  // Live /inventory vs Seller Central on DDPE0003Shop (orange). Formula is
  // not lip-only and not this SKU only — a deodorant row uses the same math.
  const orangeFba = {
    sku: "DDPE0003Shop",
    fulfillable: 4_054,
    inbound_working: 0,
    inbound_shipped: 540,
    inbound_receiving: 0,
    reserved: 1_398,
    researching: 9,
    unfulfillable: 818,
    awd_inbound: 9_999,
    snapshot_at: FBA_AT,
  };
  const orangeTpl = { sku: "DDPE0003Shop", available: 6_426, pulled_at: TPL_AT };

  test("DDPE0003-style: FBA=fulfillable, reserved in Total math, unfulfillable not in Total", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0003Shop", fba: orangeFba, tpl: orangeTpl });
    assert.equal(owned.fbaFulfillable, 4_054);
    assert.notEqual(owned.fbaFulfillable, 4_054 + 1_398 + 9 + 818);
    assert.notEqual(owned.fbaFulfillable, 6_279);
    assert.equal(owned.fbaReserved, 1_398);
    assert.equal(owned.fbaInbound, 540);
    assert.equal(owned.tplOnHand, 6_426);
    assert.equal(owned.awdOnHand, null);
    assert.equal("fbaUnfulfillable" in owned, false);
    assert.equal(owned.total, 4_054 + 1_398 + 540 + 6_426);
    assert.equal(owned.total, 12_418);
    assert.notEqual(owned.total, 4_054 + 540 + 6_426);
    assert.notEqual(owned.total, 4_054 + 1_398 + 540 + 6_426 + 818);
    assert.notEqual(owned.total, 4_054 + 1_398 + 540 + 6_426 + 9);
    assert.notEqual(owned.total, 6_819);
    assert.deepEqual(owned.missing, ["awd_on_hand"]);
  });

  test("non-lip SKU uses the identical formula — no family special case", () => {
    const deo = ownedNetworkTotal({
      sku: "DEO-LAVENDER-4OZ",
      fba: {
        ...orangeFba,
        sku: "DEO-LAVENDER-4OZ",
        fulfillable: 200,
        reserved: 50,
        inbound_working: 0,
        inbound_shipped: 10,
        inbound_receiving: 0,
        researching: 3,
        unfulfillable: 25,
      },
      tpl: { sku: "DEO-LAVENDER-4OZ", available: 100, pulled_at: TPL_AT },
      awd: { sku: "DEO-LAVENDER-4OZ", awd_on_hand: 0, pulled_at: AWD_AT },
    });
    assert.equal(deo.fbaFulfillable, 200);
    assert.equal(deo.fbaReserved, 50);
    assert.equal(deo.fbaInbound, 10);
    assert.equal(deo.tplOnHand, 100);
    assert.equal(deo.awdOnHand, 0);
    assert.equal(deo.total, 200 + 50 + 10 + 100 + 0);
    assert.notEqual(deo.total, 200 + 50 + 10 + 100 + 25);
    assert.notEqual(deo.total, 200 + 10 + 100);
    assert.equal(deo.complete, true);
  });
});

describe("missing row is omitted, not required", () => {
  test("no-row AWD is blank and Total still sums the other three", () => {
    const { fba, tpl } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", fba, tpl });
    assert.equal(owned.awdOnHand, null);
    assert.equal(owned.fbaFulfillable, 100);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.fbaInbound, 30);
    assert.equal(owned.tplOnHand, 40);
    assert.equal(owned.total, 100 + 999 + 30 + 40);
    assert.equal(owned.complete, false);
    assert.deepEqual(owned.missing, ["awd_on_hand"]);
    assert.equal(ownedAsOfLabel(owned), "2026-08-26");
    assert.match(formatOwnedAsOf(owned), /omitted awd_on_hand/);
  });

  test("missing 3PL is omitted; Total still sums FBA + inbound + AWD", () => {
    const { fba, awd } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", fba, awd, tpl: null });
    assert.equal(owned.tplOnHand, null);
    assert.equal(owned.total, 100 + 999 + 30 + 50);
    assert.equal(owned.complete, false);
    assert.deepEqual(owned.missing, ["tpl_on_hand"]);
    assert.equal(owned.fbaFulfillable, 100);
    assert.equal(owned.awdOnHand, 50);
    assert.equal(ownedAsOfLabel(owned), "2026-08-25");
    assert.match(formatOwnedAsOf(owned), /omitted tpl_on_hand/);
  });

  test("missing FBA snapshot omits fulfillable and inbound; Total still sums 3PL + AWD", () => {
    const { tpl, awd } = completeRows();
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", tpl, awd });
    assert.equal(owned.fbaFulfillable, null);
    assert.equal(owned.fbaReserved, null);
    assert.equal(owned.fbaInbound, null);
    assert.equal(owned.total, 90);
    assert.deepEqual(owned.missing, ["fba_fulfillable", "fba_reserved", "fba_inbound"]);
    assert.equal(fbaFulfillableUnits(null), null);
    assert.equal(fbaReservedUnits(null), null);
    assert.equal(fbaInboundUnits(undefined), null);
    assert.equal(tplOnHandUnits(null), null);
    assert.equal(awdOnHandUnits(null), null);
  });

  test("0-row AWD shows 0 and counts as 0 in Total", () => {
    const rows = completeRows();
    rows.awd.awd_on_hand = 0;
    rows.awd.pulled_at = "2026-08-27T10:30:00.000Z";
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(owned.awdOnHand, 0);
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 0);
    assert.equal(owned.complete, true);
    assert.equal(ownedAsOfLabel(owned), "2026-08-26");
  });

  test("known zero on a present FBA/3PL row is 0 and still completes Total", () => {
    const rows = completeRows();
    rows.tpl.available = 0;
    rows.fba.fulfillable = 0;
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(owned.tplOnHand, 0);
    assert.equal(owned.fbaFulfillable, 0);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.total, 0 + 999 + 30 + 0 + 50);
    assert.equal(owned.complete, true);
  });

  test("FBA units are fulfillable only — reserved/researching/unfulfillable stay out of FBA", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.fbaFulfillable, 100);
    assert.notEqual(owned.fbaFulfillable, 100 + 999 + 10 + 50);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 50);
  });

  test("reserved 0 on a present FBA row is 0 in Total; no FBA row omits reserved", () => {
    const rows = completeRows();
    rows.fba.reserved = 0;
    const zero = ownedNetworkTotal({ sku: "DDPE0001Shop", ...rows });
    assert.equal(zero.fbaReserved, 0);
    assert.equal(zero.total, 100 + 0 + 30 + 40 + 50);
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
    assert.equal(other.fbaFulfillable, null);
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
    assert.equal(
      fbaInboundUnits({
        inbound_working: 0,
        inbound_shipped: 0,
        inbound_receiving: 0,
        awd_inbound: 500,
      }),
      0,
    );
  });

  test("Total uses AWD on-hand only, never awd_inbound", () => {
    const owned = ownedNetworkTotal({ sku: "DDPE0001Shop", ...completeRows() });
    assert.equal(owned.awdOnHand, 50);
    assert.equal(owned.fbaInbound, 30);
    assert.notEqual(owned.total, 100 + 999 + 30 + 40 + 50 + 5000);
    assert.notEqual(owned.total, 100 + 999 + 30 + 1000 + 40 + 50);
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 50);
  });
});

describe("latest-per-SKU", () => {
  test("uses the newest snapshot_at / pulled_at per SKU", () => {
    const sources = latestOwnedSources({
      snapshots: [
        {
          sku: "DDPE0001Shop",
          fulfillable: 1,
          inbound_working: 0,
          inbound_shipped: 0,
          inbound_receiving: 0,
          snapshot_at: "2026-08-01T00:00:00.000Z",
        },
        {
          sku: "DDPE0001Shop",
          fulfillable: 100,
          inbound_working: 20,
          inbound_shipped: 5,
          inbound_receiving: 5,
          reserved: 999,
          researching: 10,
          unfulfillable: 50,
          snapshot_at: FBA_AT,
        },
      ],
      tpl: [
        { sku: "DDPE0001Shop", available: 1, pulled_at: "2026-08-17T13:13:32.000Z" },
        { sku: "DDPE0001Shop", available: 40, pulled_at: TPL_AT },
      ],
      awd: [
        { sku: "DDPE0001Shop", awd_on_hand: 1, pulled_at: "2026-08-20T00:00:00.000Z" },
        { sku: "DDPE0001Shop", awd_on_hand: 50, awd_inbound: 5000, pulled_at: AWD_AT },
      ],
    });
    const owned = ownedNetworkTotalForSku("DDPE0001Shop", sources);
    assert.equal(owned.fbaFulfillable, 100);
    assert.equal(owned.fbaReserved, 999);
    assert.equal(owned.fbaInbound, 30);
    assert.equal(owned.tplOnHand, 40);
    assert.equal(owned.awdOnHand, 50);
    assert.equal(owned.total, 100 + 999 + 30 + 40 + 50);
    assert.equal(owned.asOf.fba, FBA_AT);
    assert.equal(owned.asOf.tpl, TPL_AT);
    assert.equal(owned.asOf.awd, AWD_AT);
  });
});
