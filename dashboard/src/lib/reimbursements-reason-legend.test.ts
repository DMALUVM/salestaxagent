import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CLASSIFICATION_VERSION,
  LEDGER_REASON_LEGEND,
  isEligibleLossReason,
  isFoundReason,
  isUnknownReason,
  reasonGroup,
  reasonLabel,
} from "./reimbursements-reason-legend";

describe("Amazon ledger reason legend", () => {
  test("M is Inventory misplaced → lost_warehouse, never lost inbound", () => {
    const m = LEDGER_REASON_LEGEND.find((r) => r.code === "M");
    assert.ok(m);
    assert.equal(m?.group, "lost_warehouse");
    assert.equal(m?.label, "Inventory misplaced");
    assert.match(m?.notes ?? "", /NOT lost inbound/);
    assert.equal(reasonGroup("M"), "lost_warehouse");
    assert.notEqual(reasonGroup("M"), "lost_inbound");
    assert.equal(reasonLabel("M"), "M — Inventory misplaced");
    assert.equal(CLASSIFICATION_VERSION, "ledger-legend-2026-09-15");
  });

  test("7 is Damaged at FC, not Found", () => {
    assert.equal(isFoundReason("7"), false);
    assert.equal(isFoundReason("F"), true);
    assert.equal(reasonGroup("7"), "warehouse_damage");
    assert.equal(isEligibleLossReason("7"), true);
    assert.equal(isEligibleLossReason("F"), false);
  });

  test("Q/P/G/N are not Needs-case reasons", () => {
    for (const code of ["Q", "P", "G", "N"]) {
      assert.equal(isEligibleLossReason(code), false);
    }
    assert.equal(isUnknownReason("Q"), false);
    assert.equal(isUnknownReason("ZZZ"), true);
  });

  test("full-text reasons keep today's groups", () => {
    assert.equal(reasonGroup("Lost_Warehouse"), "lost_warehouse");
    assert.equal(reasonGroup("Lost_Inbound"), "lost_inbound");
    assert.equal(reasonGroup("Damaged_Warehouse"), "warehouse_damage");
    assert.equal(reasonLabel("Lost_Inbound"), "Lost inbound");
  });
});
