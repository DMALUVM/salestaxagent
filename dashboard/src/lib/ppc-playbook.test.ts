import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PLAYBOOK_TOP_N, isRankBlockedRaise, recToItem, topNPlaybook,
  type PlaybookRec,
} from "./ppc-playbook";

function rec(partial: Partial<PlaybookRec> & { entity_name: string }): PlaybookRec {
  return {
    id: `id-${partial.entity_name}`,
    status: "open",
    priority: "P1",
    impact_estimate: 10,
    suggested_action: `Do ${partial.entity_name}`,
    evidence: {},
    ...partial,
  };
}

describe("top-N playbook ranking", () => {
  test("caps at 10 even when 80+ recs are open", () => {
    const recs = Array.from({ length: 83 }, (_, i) =>
      rec({ entity_name: `waste-${i}`, type: "NEGATE_SEARCH_TERM",
            priority: "P0", impact_estimate: 100 - i }));
    const out = topNPlaybook(36.9, recs, []);
    assert.equal(out.length, PLAYBOOK_TOP_N);
    assert.equal(PLAYBOOK_TOP_N, 10);
  });

  test("waste (P0) outranks a larger P1 scale", () => {
    const recs = [
      rec({ entity_name: "grow", type: "INCREASE_BID", priority: "P1",
            impact_estimate: 9999,
            evidence: { rank_policy_applied: "full_increase" } }),
      rec({ entity_name: "neg", type: "NEGATE_SEARCH_TERM", priority: "P0",
            impact_estimate: 12,
            evidence: { why: "Spent $12.00 with 0 orders." } }),
    ];
    const out = topNPlaybook(36.9, recs, []);
    assert.equal(out[0].priority, "P0");
    assert.match(out[0].title, /neg/);
  });

  test("within a priority, bigger impact_estimate is first", () => {
    const recs = [
      rec({ entity_name: "small", type: "NEGATE_SEARCH_TERM", priority: "P0",
            impact_estimate: 8 }),
      rec({ entity_name: "big", type: "NEGATE_SEARCH_TERM", priority: "P0",
            impact_estimate: 80 }),
    ];
    const out = topNPlaybook(36.9, recs, []);
    assert.match(out[0].title, /big/);
    assert.match(out[1].title, /small/);
  });

  test("rank-blocked raises are not things to do", () => {
    const blocked = rec({
      entity_name: "held", type: "INCREASE_BID", priority: "P1",
      impact_estimate: 500,
      evidence: { rank_policy_applied: "capped", needs_rank_check: false },
    });
    assert.equal(isRankBlockedRaise(blocked), true);
    const waste = rec({
      entity_name: "neg", type: "NEGATE_SEARCH_TERM", priority: "P0",
      impact_estimate: 10,
    });
    const out = topNPlaybook(36.9, [blocked, waste], []);
    assert.equal(out.some((a) => a.title.includes("held")), false);
    assert.match(out[0].title, /neg/);
  });

  test("placement cut lands in the top N", () => {
    const recs = [rec({ entity_name: "grow", type: "INCREASE_BID",
                        impact_estimate: 40,
                        evidence: { rank_policy_applied: "full_increase" } })];
    const out = topNPlaybook(36.9, recs, [
      { placement: "Detail Page on-Amazon", spend: 400, sales: 200 },
    ]);
    assert.equal(out[0].priority, "P0");
    assert.match(out[0].title, /Detail Page/);
  });

  test("applied recs are skipped", () => {
    const out = topNPlaybook(36.9, [
      rec({ entity_name: "done", type: "NEGATE_SEARCH_TERM", priority: "P0",
            status: "applied", impact_estimate: 90 }),
    ], []);
    assert.deepEqual(out, []);
  });

  test("recToItem keeps id, why, and impact_estimate", () => {
    const item = recToItem(rec({
      entity_name: "chap stick", type: "NEGATE_SEARCH_TERM", priority: "P0",
      impact_estimate: 42.5,
      evidence: { why: "Spent $42.50 with 0 orders." },
    }));
    assert.equal(item.recId, "id-chap stick");
    assert.equal(item.impact, 42.5);
    assert.match(item.why, /42\.50/);
    assert.match(item.do, /chap stick/);
  });
});

describe("playbook is ranking, not a second generator", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const playbook = readFileSync(path.join(process.cwd(), "src/components/ppc-playbook.tsx"), "utf8");

  test("the page still renders the full Actions list", () => {
    assert.match(page, /Actions \(\$\{recs\.length\}\)/);
    assert.match(page, /updateRec\(r\.id, "applied"\)/);
  });

  test("PpcPlaybook is fed the live recs, not a parallel queue", () => {
    assert.match(page, /<PpcPlaybook/);
    assert.match(page, /recs=\{recs\}/);
    assert.match(playbook, /topNPlaybook/);
    assert.match(playbook, /PLAYBOOK_TOP_N/);
  });
});
