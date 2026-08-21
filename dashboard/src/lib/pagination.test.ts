import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Range pagination must always carry a deterministic ORDER BY.
 *
 * Without one, Postgres may return rows in any sequence between requests, so a
 * page boundary silently drops and duplicates rows. That is what made the /ppc
 * placement panel sum to ~$1,960 against a $2,800.73 header computed from the
 * same underlying data — two panels, one dataset, different answers.
 *
 * `date` alone is not sufficient: hundreds of rows share each date, so a 1000-row
 * page boundary lands mid-date where ordering is still undefined. The sort must
 * reach a unique key.
 */
const ROUTE = path.join(process.cwd(), "src/app/api/ppc/route.ts");
const src = readFileSync(ROUTE, "utf8");

/** Each `.range(` call, with the chained calls that precede it in the statement. */
function statementsWithRange(text: string): string[] {
  const out: string[] = [];
  let idx = 0;
  while (true) {
    const at = text.indexOf(".range(", idx);
    if (at === -1) break;
    const start = text.lastIndexOf("await sb", Math.max(0, at - 1));
    out.push(text.slice(start === -1 ? Math.max(0, at - 600) : start, at));
    idx = at + 1;
  }
  return out;
}

test("every paginated query orders by something", () => {
  const stmts = statementsWithRange(src);
  assert.ok(stmts.length >= 3, "expected several paginated queries");
  for (const s of stmts) {
    assert.ok(s.includes(".order("), `paginated query without ORDER BY:\n${s.slice(-300)}`);
  }
});

test("date-ordered queries carry a tiebreaker beyond date", () => {
  for (const s of statementsWithRange(src)) {
    const orders = [...s.matchAll(/\.order\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    if (orders.length === 0) continue;
    if (orders[0] === "date") {
      assert.ok(
        orders.length >= 2,
        `ordering only by "date" is not deterministic — many rows share a date:\n${s.slice(-300)}`,
      );
    }
  }
});

test("the placement query selects the columns it sorts on", () => {
  const stmts = statementsWithRange(src).filter((s) => s.includes("ads_placement_daily"));
  assert.equal(stmts.length, 1);
  const s = stmts[0];
  for (const col of ["date", "campaign_id", "placement"]) {
    assert.ok(s.includes(col), `placement query should select ${col}`);
  }
});

test("the campaign query selects campaign_id for its tiebreaker", () => {
  const stmts = statementsWithRange(src).filter((s) => s.includes("CAMPAIGN_COLS"));
  assert.ok(stmts.length >= 1);
  assert.ok(src.includes('"date,campaign_id,campaign_name'),
    "CAMPAIGN_COLS must include campaign_id");
});
