import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import { fcToState } from "./fc-codes";

const MAPPED_2026_09_02: Record<string, string> = {
  BDU2: "CO",
  IGA3: "GA",
  ILM1: "NC",
  IMO1: "MO",
  ITX3: "TX",
  IWA6: "WA",
};

describe("verified 2026-09-02 FC street-address mappings", () => {
  for (const [code, state] of Object.entries(MAPPED_2026_09_02)) {
    test(`${code} → ${state}`, () => {
      assert.equal(fcToState(code), state);
    });
  }

  test("letters in the code are not the state", () => {
    assert.equal(fcToState("IWA6"), "WA");
    assert.equal(fcToState("ILM1"), "NC");
  });

  test("AWD is not a state", () => {
    assert.equal(fcToState("AWD"), null);
  });

  test("JSON mirror agrees with config/fc_codes.json", () => {
    const root = path.join(process.cwd(), "..");
    const py = JSON.parse(
      readFileSync(path.join(root, "config", "fc_codes.json"), "utf8"),
    ).fc_codes;
    const ts = JSON.parse(
      readFileSync(path.join(process.cwd(), "src/lib/parsers/fc-codes-data.json"), "utf8"),
    ).fc_codes;
    assert.deepEqual(ts, py);
  });
});
