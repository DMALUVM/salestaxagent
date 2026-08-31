import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadShippedAsinTitleOverrides,
  parseAsinTitleOverrides,
  resolveParentProductNames,
} from "./amazon-ops-titles";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const LIP = "B0CLHTF8YN";
const BALM = "B0DQFKMJFY";
const DEO = "B0HBSZ71XQ";

const PARENTS: Record<string, string> = {
  [LIP]: "Tallowbourn Lip Balm 3pk",
  [BALM]: "Tallowbourn Tallow Balm for Face & Body",
  [DEO]: "Tallowbourn Tallow Deodorant",
};

const SWEET_ORANGE =
  "Tallowbourn Moisturizing Grass-Fed Beef Tallow Lip Balm 3pk – Sweet Orange";

const CHILD_TITLES = [
  { asin: "B0CLHTKY3V", product_name: SWEET_ORANGE },
  { asin: "B0HBSZAAAA", product_name: "Tallowbourn Tallow Deodorant – Cedar" },
  { asin: "B0DQFKBBBB", product_name: "Tallowbourn Tallow Balm – Travel" },
];

describe("amazon-ops parent titles", { concurrency: false }, () => {
  test("skips _comment and non-string keys", () => {
    const parsed = parseAsinTitleOverrides({
      _comment: "Manual parent ASIN title overrides.",
      [LIP]: "Tallowbourn Lip Balm 3pk",
      B0FAKE: "   ",
    });
    assert.equal(parsed._comment, undefined);
    assert.equal(parsed[LIP], "Tallowbourn Lip Balm 3pk");
    assert.equal(Object.keys(parsed).length, 1);
  });

  test("all three parent ASINs resolve from the shipped JSON when cwd is dashboard/", () => {
    // Vercel cwd is dashboard/ — repo-root config/asin_titles.json is not there.
    const prev = process.cwd();
    const fakeDashboard = mkdtempSync(path.join(tmpdir(), "dashboard-"));
    process.chdir(fakeDashboard);
    try {
      const overrides = loadShippedAsinTitleOverrides();
      assert.equal(overrides._comment, undefined);
      const rows = resolveParentProductNames(
        [
          { parent_asin: LIP, product_name: null },
          { parent_asin: DEO, product_name: null },
          { parent_asin: BALM, product_name: null },
        ],
        overrides,
        CHILD_TITLES,
      );
      assert.equal(rows[0].product_name, PARENTS[LIP]);
      assert.equal(rows[1].product_name, PARENTS[DEO]);
      assert.equal(rows[2].product_name, PARENTS[BALM]);
      assert.doesNotMatch(rows[0].product_name ?? "", /Sweet Orange/);
    } finally {
      process.chdir(prev);
    }
  });

  test("B0CLHTF8YN does not use a child variant title from sku_velocity", () => {
    const rows = resolveParentProductNames(
      [{ parent_asin: LIP, product_name: null }],
      loadShippedAsinTitleOverrides(),
      CHILD_TITLES,
    );
    assert.equal(rows[0].product_name, PARENTS[LIP]);
    assert.notEqual(rows[0].product_name, SWEET_ORANGE);
    assert.doesNotMatch(rows[0].product_name ?? "", /Sweet Orange|–| - /);
  });

  test("missing override does not pick a child variant by 6-char prefix", () => {
    const parent = "B0CLHTXXXX";
    const rows = resolveParentProductNames(
      [{ parent_asin: parent, product_name: null }],
      {},
      [
        { asin: "B0CLHTKY3V", product_name: SWEET_ORANGE },
        { asin: "B0CLHTAAAA", product_name: "Tallowbourn Lip Balm 3pk – Peppermint" },
      ],
    );
    assert.equal(rows[0].product_name, null);
    assert.notEqual(rows[0].product_name, SWEET_ORANGE);
  });

  test("override wins over an existing child-variant product_name", () => {
    const rows = resolveParentProductNames(
      [{ parent_asin: LIP, product_name: SWEET_ORANGE }],
      loadShippedAsinTitleOverrides(),
      CHILD_TITLES,
    );
    assert.equal(rows[0].product_name, PARENTS[LIP]);
  });

  test("exact parent ASIN in DB is used only when there is no override", () => {
    const rows = resolveParentProductNames(
      [{ parent_asin: "B0NEWMISSING", product_name: null }],
      {},
      [{ asin: "B0NEWMISSING", product_name: "Tallowbourn New Parent" }],
    );
    assert.equal(rows[0].product_name, "Tallowbourn New Parent");
  });

  test("route no longer cwd-reads or prefix-matches child ASINs", () => {
    const route = readFileSync(
      path.join(HERE, "../app/api/amazon-ops/route.ts"),
      "utf8",
    );
    assert.match(route, /loadShippedAsinTitleOverrides/);
    assert.match(route, /resolveParentProductNames/);
    assert.doesNotMatch(route, /process\.cwd\(\)/);
    assert.doesNotMatch(route, /slice\(0,\s*6\)/);
    assert.doesNotMatch(route, /startsWith\(prefix\)/);
    assert.doesNotMatch(route, /split\(" - "\)/);
  });
});
