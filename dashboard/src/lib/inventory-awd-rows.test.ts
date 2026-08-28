import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  awdCellTone,
  awdCellToneClass,
  awdDisplayUnits,
  awdRowInbound,
  awdRowOnHand,
  isAwdHighWaterCard,
  keepAwdInventoryRows,
} from "./inventory-awd-rows";
import { awdOnHandUnits } from "./inventory-owned-total";

const PULLED = "2026-08-27T10:30:00.000Z";

describe("keep AWD 0-qty rows", () => {
  test("a present row with awd_on_hand=0 is kept as 0", () => {
    const rows = keepAwdInventoryRows([
      { sku: "DDPE0001Shop", awd_on_hand: 0, awd_inbound: 0, pulled_at: PULLED },
      { sku: "DDPE0002Shop", awd_on_hand: 0, awd_inbound: 0, pulled_at: PULLED },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(awdRowOnHand(rows[0]), 0);
    assert.equal(awdOnHandUnits(rows[0]), 0);
    assert.equal(isAwdHighWaterCard(awdRowOnHand(rows[0])), false);
  });

  test("no row stays missing — never a fake 0 or the 76,211 high-water card", () => {
    const rows = keepAwdInventoryRows([
      { sku: "DDPE0001Shop", awd_on_hand: 0, pulled_at: PULLED },
    ]);
    const orange = rows.find((r) => r.sku === "DDPE0003Shop");
    assert.equal(orange, undefined);
    assert.equal(awdOnHandUnits(undefined), null);
    assert.equal(awdRowOnHand(undefined), null);
    assert.equal(awdDisplayUnits(undefined), null);
    assert.equal(isAwdHighWaterCard(76_211), true);
    assert.equal(
      rows.some((r) => Number(r.awd_on_hand) === 76_211),
      false,
    );
  });
});

describe("AWD column is on-hand + inbound to AWD", () => {
  test("unscented 0 on-hand + 1080 inbound shows 1080, not transit", () => {
    const row = {
      sku: "DDPE0001Shop",
      awd_on_hand: 0,
      awd_inbound: 1_080,
      awd_to_fba_in_transit: 2,
      pulled_at: PULLED,
    };
    assert.equal(awdRowOnHand(row), 0);
    assert.equal(awdRowInbound(row), 1_080);
    assert.equal(awdDisplayUnits(row), 1_080);
    assert.equal(awdOnHandUnits(row), 1_080);
    assert.notEqual(awdOnHandUnits(row), 0);
    assert.notEqual(awdOnHandUnits(row), 1_082);
  });

  test("missing row stays blank unless inbound exists", () => {
    assert.equal(awdOnHandUnits(null), null);
    assert.equal(awdDisplayUnits(undefined), null);
    const inboundOnly = { sku: "X", awd_inbound: 1_080 };
    assert.equal(awdOnHandUnits(inboundOnly), 1_080);
    assert.equal(awdDisplayUnits(inboundOnly), 1_080);
  });
});

describe("AWD number color (text only, no cell fill)", () => {
  test("white = inbound only; orange = partial; green = available; blank = none", () => {
    assert.equal(
      awdCellTone({ sku: "DDPE0001Shop", awd_on_hand: 0, awd_inbound: 1_080 }),
      "white",
    );
    assert.equal(
      awdCellTone({ sku: "DDPE0001Shop", awd_inbound: 1_080 }),
      "white",
    );
    assert.equal(
      awdCellTone({ sku: "X", awd_on_hand: 64, awd_inbound: 200 }),
      "orange",
    );
    assert.equal(
      awdCellTone({ sku: "Y", awd_on_hand: 64, awd_inbound: 0 }),
      "green",
    );
    assert.equal(awdCellTone(null), null);
    assert.equal(awdCellTone({ sku: "Z", awd_on_hand: 0, awd_inbound: 0 }), null);
    assert.match(awdCellToneClass("white"), /text-sky-3/);
    assert.doesNotMatch(awdCellToneClass("white"), /text-zinc-200/);
    assert.doesNotMatch(awdCellToneClass("white"), /text-foreground/);
    assert.match(awdCellToneClass("orange"), /text-orange/);
    assert.match(awdCellToneClass("green"), /text-emerald/);
    assert.doesNotMatch(awdCellToneClass("white"), /bg-/);
    assert.doesNotMatch(awdCellToneClass("orange"), /bg-/);
    assert.doesNotMatch(awdCellToneClass("green"), /bg-/);
    assert.equal(awdCellToneClass(null), "");
  });
});
