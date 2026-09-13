import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GNO_DECISION_RULES,
  GNO_LEDGER_RECENT_LIMIT,
  GNO_OUTCOME_CSV_HEADERS,
  GNO_SOURCE_DOCS,
  TALLOWBOURN_PPC_DESK,
  filterGnoRules,
  gnoDecisionRulesTxt,
  gnoOutcomesCsv,
  ledgerRecent,
} from "./gno-methodology";

describe("gno methodology reference", () => {
  it("points at the external tallowbourn-ppc desk instead of cloning it", () => {
    assert.equal(TALLOWBOURN_PPC_DESK.vercel, "https://tallowbourn-ppc.vercel.app");
    assert.equal(TALLOWBOURN_PPC_DESK.url, TALLOWBOURN_PPC_DESK.vercel);
    assert.match(TALLOWBOURN_PPC_DESK.github, /tallowbourn-ppc/);
    assert.match(TALLOWBOURN_PPC_DESK.why, /SKU economics|152-source|execution center/i);
  });

  it("keeps family CM BE as the SoT and labels 37% as a GNO scenario", () => {
    const be = GNO_DECISION_RULES.find((rule) => rule.id === "family-cm-be");
    const bleeders = GNO_DECISION_RULES.find((rule) => rule.id === "bleeders-2");
    assert.ok(be);
    assert.ok(bleeders);
    assert.match(be!.practice, /lip 42%|deo 36%|balm 36%/i);
    assert.match(be!.application, /37% is a scenario/i);
    assert.match(bleeders!.application, /scenario, not this desk's SoT/i);
  });

  it("filters rules by text and category", () => {
    const harvest = filterGnoRules("harvest", "harvesting");
    assert.ok(harvest.some((rule) => rule.id === "harvest-coverage"));
    assert.ok(harvest.every((rule) => rule.category === "harvesting"));
    const observe = GNO_DECISION_RULES.filter((rule) =>
      /never writes|never auto-pauses|never raises/i.test(rule.application));
    assert.ok(observe.length >= 2);
  });

  it("renders a pack-ready rules text and outcomes CSV", () => {
    const txt = gnoDecisionRulesTxt();
    assert.match(txt, /GNO decision rules/);
    assert.match(txt, /tallowbourn-ppc/);
    assert.match(txt, /Family CM break-even/);
    assert.match(txt, /Observe only/);
    assert.ok(!/amazon ads write|bid mutation|create campaign/i.test(txt));

    const empty = gnoOutcomesCsv([]);
    assert.equal(empty.trim(), GNO_OUTCOME_CSV_HEADERS.join(","));

    const csv = gnoOutcomesCsv([
      {
        id: "1",
        created_at: "2026-09-13T12:00:00Z",
        pack_date: "2026-09-13",
        dave_action: "hold",
        campaign_name: "Lip Exact",
        search_term: "tallow lip balm",
        term_family: "balm lip tallow",
        proposed_tag: "KEEP",
        source: "ui",
        notes: "keeper, wait",
      },
    ]);
    assert.match(csv, /tallow lip balm/);
    assert.match(csv, /hold/);
    assert.match(csv, /keeper, wait/);
  });

  it("caps the on-page ledger and lists source docs plus the full library pointer", () => {
    assert.equal(GNO_LEDGER_RECENT_LIMIT, 25);
    const rows = ledgerRecent(
      Array.from({ length: 40 }, (_, i) => ({
        id: String(i),
        created_at: `2026-09-13T00:00:${String(i).padStart(2, "0")}Z`,
        dave_action: "hold" as const,
      })),
    );
    assert.equal(rows.length, 25);
    assert.ok(GNO_SOURCE_DOCS.some((doc) => /152-source/i.test(doc.note)));
    assert.ok(GNO_SOURCE_DOCS.some((doc) => doc.id === "bidding"));
  });
});
