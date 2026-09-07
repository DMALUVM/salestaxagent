import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  gnoAlertKey,
  isAlertDone,
  mergeDoneKeys,
  splitDoneAlerts,
  toggleDoneKey,
} from "./gno-alert-done";

const p0 = {
  code: "KEEPER_NOT_ENABLED",
  campaign_name: "SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG",
  search_term: undefined,
};

describe("GNO alert Done checkoff", () => {
  test("keys collapse extra spaces so the same keeper matches", () => {
    const a = gnoAlertKey(p0);
    const b = gnoAlertKey({
      ...p0,
      campaign_name: "SP | TBL - 3Pck | B0CLHTKY3V | Auto | Loose Match-TOS | SSG",
    });
    assert.equal(a, b);
    assert.match(a, /^KEEPER_NOT_ENABLED\t/);
  });

  test("toggle Done is local only — never implies an Amazon write", () => {
    const key = gnoAlertKey(p0);
    const on = toggleDoneKey([], key, true);
    assert.deepEqual(on, [key]);
    const off = toggleDoneKey(on, key, false);
    assert.deepEqual(off, []);
  });

  test("splitDoneAlerts hides checked P0 from the open strip", () => {
    const missing = {
      code: "KEEPER_MISSING",
      campaign_name: "GG - Lip Balm - Broad M",
    };
    const { open, done } = splitDoneAlerts(
      [p0, missing],
      [gnoAlertKey(p0)],
    );
    assert.equal(open.length, 1);
    assert.equal(open[0].code, "KEEPER_MISSING");
    assert.equal(done.length, 1);
    assert.equal(isAlertDone(p0, [gnoAlertKey(p0)]), true);
    assert.equal(isAlertDone(missing, [gnoAlertKey(p0)]), false);
  });

  test("mergeDoneKeys unions server acks with local checkoffs", () => {
    const a = gnoAlertKey(p0);
    const b = gnoAlertKey({ code: "NEW_EXACT_BURN", campaign_name: "x" });
    assert.deepEqual(new Set(mergeDoneKeys([a], [a, b], [])), new Set([a, b]));
  });
});
