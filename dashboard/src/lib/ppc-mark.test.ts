import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { decisionPatch, isMarkableStatus, loopCounts, markBleeder } from "./ppc-mark";

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

describe("bleeder checkbox writes applied on ads_action_decisions", () => {
  test("markBleeder upserts status=applied and applied_at, never Amazon", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const sb = {
      from: (table: string) => {
        assert.equal(table, "ads_action_decisions");
        return {
          upsert: (row: Record<string, unknown>) => {
            writes.push(row);
            return {
              select: async () => ({ data: [{ id: "dec-bleeder" }], error: null }),
            };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      },
    };
    const result = await markBleeder(sb, {
      checklist_id: "2026-08-29|c1|ag1|dud|BROAD|negative_exact",
      as_of: "2026-08-29",
      rec_type: "BLEEDER_NEGATIVE_EXACT",
      action_type: "negative_exact",
      campaign_id: "c1",
      campaign_name: "SP Exact",
      search_term: "dud",
      priority: "P0",
      impact_estimate: 7,
    }, "applied", "2026-09-01T12:00:00.000Z");
    assert.equal(result.ok, true);
    assert.equal(result.decisionLogged, true);
    assert.equal(result.decisionId, "dec-bleeder");
    assert.equal(result.status, "applied");
    assert.equal(writes[0].status, "applied");
    assert.equal(writes[0].applied_at, "2026-09-01T12:00:00.000Z");
    assert.equal(writes[0].entity_name, "2026-08-29|c1|ag1|dud|BROAD|negative_exact");
  });

  test("markBleeder dismissed writes dismissed_at", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const sb = {
      from: (table: string) => {
        assert.equal(table, "ads_action_decisions");
        return {
          upsert: (row: Record<string, unknown>) => {
            writes.push(row);
            return { select: async () => ({ data: [{ id: "dec-skip" }], error: null }) };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      },
    };
    const result = await markBleeder(sb, {
      checklist_id: "id1", as_of: "2026-08-29", rec_type: "WEEKLY_NEGATIVE_EXACT",
      action_type: "negative_exact", campaign_id: "c1", search_term: "dud",
    }, "dismissed", "2026-09-01T12:00:00.000Z");
    assert.equal(result.ok, true);
    assert.equal(result.status, "dismissed");
    assert.equal(writes[0].status, "dismissed");
    assert.equal(writes[0].dismissed_at, "2026-09-01T12:00:00.000Z");
  });

  test("rejects auto-apply", async () => {
    const result = await markBleeder({
      from: () => { throw new Error("must not write"); },
    }, {
      checklist_id: "x", as_of: "2026-08-29", rec_type: "BLEEDER_NEGATIVE_EXACT",
      action_type: "negative_exact", campaign_id: "c1",
    }, "auto-apply");
    assert.equal(result.ok, false);
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

  test("This week Done/Skipped posts to /api/ppc/mark", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders.tsx"), "utf8");
    assert.match(ui, /fetch\("\/api\/ppc\/mark"/);
    assert.match(ui, /bleeder:/);
    assert.match(ui, /"applied"/);
    assert.match(ui, /"dismissed"/);
    assert.match(ui, /Done/);
    assert.match(ui, /Skipped/);
    assert.doesNotMatch(ui, /amazonads|auto-apply/i);
  });

  test("the mark route updates both tables with decisionPatch", () => {
    assert.match(mark, /ads_recommendations/);
    assert.match(mark, /ads_action_decisions/);
    assert.match(mark, /decisionPatch/);
    assert.match(mark, /Never auto-applies/);
    assert.match(mark, /markBleeder/);
    assert.doesNotMatch(mark, /auto-apply|amazonads\.amazon/);
  });

  test("legacy POST {id,status} still mirrors onto the decision log", () => {
    assert.match(legacy, /decisionPatch/);
    assert.match(legacy, /ads_action_decisions/);
  });
});
