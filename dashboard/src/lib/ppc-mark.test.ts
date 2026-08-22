import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { decisionPatch, isMarkableStatus, loopCounts } from "./ppc-mark";

describe("decisionPatch — same columns as ads-mark", () => {
  test("applied writes applied_at", () => {
    const p = decisionPatch("applied", "2026-08-22T12:00:00.000Z");
    assert.deepEqual(p, { status: "applied", applied_at: "2026-08-22T12:00:00.000Z" });
  });

  test("dismissed writes dismissed_at, not applied_at", () => {
    const p = decisionPatch("dismissed", "2026-08-22T12:00:00.000Z");
    assert.equal(p?.status, "dismissed");
    assert.equal(p?.dismissed_at, "2026-08-22T12:00:00.000Z");
    assert.equal("applied_at" in (p ?? {}), false);
  });

  test("rejects statuses the learning loop does not own", () => {
    assert.equal(decisionPatch("auto-apply", "x"), null);
    assert.equal(isMarkableStatus("auto-apply"), false);
    assert.equal(isMarkableStatus("applied"), true);
  });
});

describe("loopCounts", () => {
  test("applied awaiting is applied minus those with any outcome row", () => {
    const decisions = [
      { id: "a", status: "applied" },
      { id: "b", status: "applied" },
      { id: "c", status: "open" },
    ];
    const outcomes = [{ decision_id: "a" }, { decision_id: "a" }];
    assert.deepEqual(loopCounts(decisions, outcomes), {
      applied: 2, appliedAwaiting: 1, outcomesRecorded: 2,
    });
  });
});

describe("dashboard Apply/Dismiss hits /api/ppc/mark", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const mark = readFileSync(path.join(process.cwd(), "src/app/api/ppc/mark/route.ts"), "utf8");
  const legacy = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");

  test("updateRec posts to /api/ppc/mark, not a second store", () => {
    assert.match(page, /fetch\("\/api\/ppc\/mark"/);
    assert.match(page, /Mark applied/);
    assert.doesNotMatch(page, /amazonads|ads-api|sp-api.*write/i);
  });

  test("the mark route updates both tables with decisionPatch", () => {
    assert.match(mark, /ads_recommendations/);
    assert.match(mark, /ads_action_decisions/);
    assert.match(mark, /decisionPatch/);
    assert.match(mark, /Never auto-applies/);
    assert.doesNotMatch(mark, /auto-apply|amazonads\.amazon/);
  });

  test("legacy POST {id,status} still mirrors onto the decision log", () => {
    assert.match(legacy, /decisionPatch/);
    assert.match(legacy, /ads_action_decisions/);
  });
});
