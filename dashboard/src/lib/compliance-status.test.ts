import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

import { isRegistered, countNeedsRegistration } from "./compliance-status";

describe("isRegistered", () => {
  test("coerces boolean / string / number truthy forms", () => {
    assert.equal(isRegistered(true), true);
    assert.equal(isRegistered("true"), true);
    assert.equal(isRegistered(1), true);
    assert.equal(isRegistered("1"), true);
  });

  test("rejects falsey and unexpected values", () => {
    assert.equal(isRegistered(false), false);
    assert.equal(isRegistered("false"), false);
    assert.equal(isRegistered(0), false);
    assert.equal(isRegistered(null), false);
    assert.equal(isRegistered(undefined), false);
    assert.equal(isRegistered(""), false);
    assert.equal(isRegistered("yes"), false);
  });

  test("accepts a nexus row so Overview cannot count 0 against 22 registered", () => {
    const registered = { state_code: "NC", is_registered: true };
    const pending = { state_code: "PA", is_registered: false };
    assert.equal(isRegistered(registered), true);
    assert.equal(isRegistered(pending), false);
    assert.equal(isRegistered(registered.is_registered), true);

    const rows = [
      { is_registered: true },
      { is_registered: "true" },
      { is_registered: 1 },
      { is_registered: false },
      { is_registered: null },
    ];
    assert.equal(rows.filter((n) => isRegistered(n)).length, 3);
    assert.equal(rows.filter((n) => isRegistered(n.is_registered)).length, 3);
  });
});

describe("countNeedsRegistration", () => {
  test("ignores already-registered states", () => {
    assert.equal(
      countNeedsRegistration([
        { has_economic_nexus: true, is_registered: true },
        { has_physical_nexus: true, is_registered: false },
      ]),
      1,
    );
  });
});

describe("Overview registered tile", () => {
  test("reads is_registered, not the whole nexus object", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    assert.match(
      src,
      /isRegistered\(\w+\.is_registered\)/,
      "Pulse must pass n.is_registered — passing the row used to show 0",
    );
  });
});
