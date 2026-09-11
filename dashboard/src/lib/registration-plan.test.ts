import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ACTIONS,
  TESS_PACKET_DATE,
  aggregateSales12m,
  buildPlan,
  bundledCitations,
  bundledStateRules,
  countsByAction,
  decide,
  sortRows,
  toApiRows,
  trailing12mCutoff,
  type PlanRow,
  type StateFacts,
} from "./registration-plan";

function facts(overrides: Partial<StateFacts> = {}): StateFacts {
  return {
    state_code: "XX",
    has_sales_tax: true,
    is_registered: false,
    fba_rule: "unknown_default_true",
    inventory_events: 0,
    inventory_first: null,
    inventory_last: null,
    economic_exceeded: false,
    economic_pct: 0,
    shopify_sales: 0,
    amazon_sales: 0,
    entity_exposure: false,
    documentation_status: "",
    tess_posture: "",
    tess_confidence: "",
    tess_citation: "",
    tess_packet_date: "",
    ...overrides,
  };
}

function tessFacts(state: string, overrides: Partial<StateFacts> = {}): StateFacts {
  const pkt = bundledCitations()[state];
  assert.ok(pkt, `missing Tess packet for ${state}`);
  return facts({
    state_code: state,
    inventory_events: 100,
    inventory_first: "2024-01-01",
    documentation_status: pkt.documentation_status,
    tess_posture: pkt.posture,
    tess_confidence: pkt.confidence,
    tess_citation: pkt.short_citation,
    tess_packet_date: pkt.packet_date ?? TESS_PACKET_DATE,
    ...overrides,
  });
}

function row(f: StateFacts): PlanRow {
  return { facts: f, decision: decide(f), entity_note: "", residual_risk: "" };
}

test("no-sales-tax states never become register_now", () => {
  for (const state of ["AK", "DE", "MT", "NH", "OR"]) {
    const d = decide(facts({
      state_code: state,
      has_sales_tax: false,
      inventory_events: 5000,
      inventory_first: "2024-01-01",
      economic_exceeded: true,
      economic_pct: 400,
    }));
    assert.equal(d.action, "no_sales_tax");
  }
});

test("entity exposure is footnoted, not promoted, on a no-tax state", () => {
  const d = decide(facts({ state_code: "DE", has_sales_tax: false, entity_exposure: true }));
  assert.equal(d.action, "no_sales_tax");
  assert.match(d.reason, /\/entity/);
});

test("registration short-circuits triggers", () => {
  const d = decide(facts({
    is_registered: true,
    economic_exceeded: true,
    inventory_events: 100,
    inventory_first: "2024-01-01",
  }));
  assert.equal(d.action, "already_registered");
});

test("registered state is not work to do", () => {
  const rows = [row(facts({ state_code: "A", is_registered: true }))];
  assert.equal(countsByAction(rows).register_now, 0);
});

test("economic nexus exceeded is register_now", () => {
  const d = decide(facts({ economic_exceeded: true, economic_pct: 145, amazon_sales: 250_000 }));
  assert.equal(d.action, "register_now");
  assert.equal(d.economic_nexus, "Y");
  assert.match(d.reason, /economic threshold exceeded/);
});

test("economic outranks a contested FBA rule", () => {
  const d = decide(facts({
    fba_rule: "false",
    inventory_events: 900,
    inventory_first: "2024-01-01",
    economic_exceeded: true,
    economic_pct: 130,
  }));
  assert.equal(d.action, "register_now");
  assert.equal(d.physical_nexus, "contested");
});

test("approaching is monitor with a percentage", () => {
  const d = decide(facts({ economic_pct: 88, amazon_sales: 88_000 }));
  assert.equal(d.action, "monitor");
  assert.equal(d.economic_nexus, "approaching 88%");
});

test("below the warn band is plain monitor", () => {
  const d = decide(facts({ economic_pct: 12 }));
  assert.equal(d.action, "monitor");
  assert.equal(d.economic_nexus, "N");
});

test("inventory with a true rule is high-confidence register_now", () => {
  const d = decide(facts({
    fba_rule: "true",
    inventory_events: 1200,
    inventory_first: "2024-01-01",
  }));
  assert.equal(d.action, "register_now");
  assert.equal(d.confidence, "high");
  assert.equal(d.physical_nexus, "Y");
});

test("unknown default with inventory is not register_now", () => {
  const d = decide(facts({
    fba_rule: "unknown_default_true",
    inventory_events: 800,
    inventory_first: "2024-03-01",
  }));
  assert.equal(d.action, "needs_statute_review");
  assert.notEqual(d.action, "register_now");
  assert.equal(d.confidence, "low");
  assert.equal(d.documentation_status, "unknown");
  assert.equal(d.authority_source, "unknown_default");
  assert.doesNotMatch(d.reason, /unresearched/);
  assert.match(d.reason, /Insufficient authority/);
});

test("rule saying no nexus is review, never register", () => {
  for (const rule of ["false", "False"]) {
    const d = decide(facts({
      fba_rule: rule,
      inventory_events: 4470,
      inventory_first: "2024-01-01",
    }));
    assert.equal(d.action, "review_contested");
    assert.match(d.reason, /does NOT create nexus/);
  }
});

test("unsettled rules are review", () => {
  for (const rule of ["contested", "conditional"]) {
    const d = decide(facts({
      fba_rule: rule,
      inventory_events: 50,
      inventory_first: "2025-01-01",
    }));
    assert.equal(d.action, "review_contested");
    assert.equal(d.confidence, "medium");
  }
});

test("no inventory means no physical nexus", () => {
  assert.equal(decide(facts()).physical_nexus, "N");
});

test("contested never becomes register_now silently", () => {
  for (const rule of ["false", "contested", "conditional", "unknown_default_true"]) {
    for (const events of [1, 100, 99_999]) {
      const d = decide(facts({
        fba_rule: rule,
        inventory_events: events,
        inventory_first: "2024-01-01",
      }));
      assert.notEqual(d.action, "register_now", `${rule} / ${events}`);
    }
  }
});

test("entity exposure alone never triggers registration", () => {
  assert.equal(decide(facts({ entity_exposure: true })).action, "monitor");
});

test("entity exposure does not change the action", () => {
  const a = decide(facts({ entity_exposure: false, inventory_events: 10, inventory_first: "2024-01-01" }));
  const b = decide(facts({ entity_exposure: true, inventory_events: 10, inventory_first: "2024-01-01" }));
  assert.equal(a.action, b.action);
  assert.equal(a.confidence, b.confidence);
});

test("work comes first in sort order", () => {
  const registered = facts({ state_code: "Z", is_registered: true });
  const work = facts({ state_code: "Y", amazon_sales: 1, fba_rule: "true", inventory_events: 1, inventory_first: "2024-01-01" });
  const sorted = sortRows([row(registered), row(work)]);
  assert.equal(sorted[0].decision.action, "register_now");
});

test("within an action bigger exposure ranks higher", () => {
  const small = facts({ state_code: "S", amazon_sales: 1_000, inventory_events: 5, inventory_first: "2024-01-01" });
  const big = facts({ state_code: "B", amazon_sales: 500_000, inventory_events: 5, inventory_first: "2024-01-01" });
  assert.deepEqual(
    sortRows([row(small), row(big)]).map((r) => r.facts.state_code),
    ["B", "S"],
  );
});

test("action vocabulary is closed", () => {
  for (const rule of ["true", "false", "contested", "conditional", "unknown_default_true"]) {
    for (const reg of [true, false]) {
      for (const tax of [true, false]) {
        const d = decide(facts({
          fba_rule: rule,
          is_registered: reg,
          has_sales_tax: tax,
          inventory_events: 3,
          inventory_first: "2024-01-01",
        }));
        assert.ok((ACTIONS as readonly string[]).includes(d.action), d.action);
      }
    }
  }
});

test("API rows keep channel totals as the sum", () => {
  const f = facts({ shopify_sales: 100.25, amazon_sales: 200.75 });
  const api = toApiRows([row(f)]);
  assert.equal(api[0].total_relevant_sales, "301.00");
  assert.equal(api[0].recommended_action, "monitor");
});

test("quarantined Amazon tax sources do not inflate plan sales", () => {
  const sales = aggregateSales12m(
    [
      { state_code: "CA", channel: "amazon", source: "amazon_spapi", gross_sales: 50_000, period_end: "2026-08-01" },
      { state_code: "CA", channel: "amazon", source: "amazon_custom_combined_tax", gross_sales: 999_999, period_end: "2026-08-01" },
      { state_code: "CA", channel: "shopify", source: "shopify_api", gross_sales: 1200, period_end: "2026-08-01" },
    ],
    "2025-01-01",
  );
  assert.equal(sales.CA.amazon, 50_000);
  assert.equal(sales.CA.shopify, 1200);
});

test("trailing-12m cutoff is 365 days before the reference date", () => {
  assert.equal(trailing12mCutoff("2026-09-11"), "2025-09-11");
});

test("bundled rules match Python state_rules on FBA and no-tax invariants", () => {
  const bundled = bundledStateRules();
  assert.deepEqual(
    Object.keys(bundled).filter((sc) => !bundled[sc].has_sales_tax).sort(),
    ["AK", "DE", "MT", "NH", "OR"],
  );

  const parent = path.join(process.cwd(), "..", "config", "state_rules.json");
  if (!existsSync(parent)) return;
  const src = JSON.parse(readFileSync(parent, "utf8")) as {
    states: Record<string, { has_sales_tax?: boolean; fba_inventory_creates_nexus?: string }>;
  };
  for (const [sc, rule] of Object.entries(src.states)) {
    assert.equal(bundled[sc]?.has_sales_tax, rule.has_sales_tax !== false, sc);
    assert.equal(
      bundled[sc]?.fba_inventory_creates_nexus,
      String(rule.fba_inventory_creates_nexus ?? "unknown_default_true"),
      `${sc} fba rule`,
    );
  }
});

test("live-shaped inventory uses Tess packets, not unknown_default register_now", () => {
  const inventory: Record<string, { events: number; min_date: string; max_date: string }> = {};
  for (const sc of ["MO", "ID", "AL", "LA", "NM", "MS", "NY", "IL", "AZ"]) {
    inventory[sc] = { events: 100, min_date: "2024-01-01", max_date: "2026-09-01" };
  }
  const nexus: Record<string, { is_registered: boolean }> = {};
  // 35 registered sales-tax states (51 − 5 no-tax − 9 inventory work − 2 monitor).
  const skip = new Set(["MO", "ID", "AL", "LA", "NM", "MS", "NY", "IL", "AZ", "ME", "DC", "AK", "DE", "MT", "NH", "OR"]);
  for (const sc of Object.keys(bundledStateRules())) {
    if (!skip.has(sc)) nexus[sc] = { is_registered: true };
  }
  const rows = buildPlan({
    rules: bundledStateRules(),
    nexus,
    inventory,
    sales: {},
    entityStates: [],
  });
  const c = countsByAction(rows);
  assert.equal(c.register_now, 3);
  assert.equal(c.needs_statute_review, 3);
  assert.equal(c.review_contested, 3);
  assert.equal(c.no_sales_tax, 5);
  assert.equal(c.already_registered, 35);
  assert.deepEqual(
    rows.filter((r) => r.decision.action === "register_now").map((r) => r.facts.state_code).sort(),
    ["ID", "LA", "NM"],
  );
  assert.deepEqual(
    rows.filter((r) => r.decision.action === "needs_statute_review").map((r) => r.facts.state_code).sort(),
    ["AL", "MO", "MS"],
  );
  assert.deepEqual(
    rows.filter((r) => r.decision.action === "review_contested").map((r) => r.facts.state_code).sort(),
    ["AZ", "IL", "NY"],
  );
});

test("buildPlan uses bundled no-tax / contested rules even if warehouse omits them", () => {
  const rows = buildPlan({
    rules: bundledStateRules(),
    nexus: {},
    inventory: {
      NY: { events: 4000, min_date: "2024-01-01", max_date: "2026-09-01" },
      MO: { events: 800, min_date: "2024-06-01", max_date: "2026-09-01" },
      OR: { events: 10, min_date: "2025-01-01", max_date: "2026-01-01" },
    },
    sales: {},
    entityStates: [],
  });
  const by = Object.fromEntries(rows.map((r) => [r.facts.state_code, r.decision.action]));
  assert.equal(by.NY, "review_contested");
  assert.equal(by.MO, "needs_statute_review");
  assert.equal(by.OR, "no_sales_tax");
});

test("API route never shells out to Python", () => {
  const route = readFileSync(
    path.join(process.cwd(), "src/app/api/registration-plan/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(route, /child_process|execFile|spawnSync|promisify/);
  assert.match(route, /loadRegistrationPlanFromWarehouse/);
  assert.doesNotMatch(route, /Run it in a terminal/);
});

test("Nexus card does not tell operators to run the CLI", () => {
  const ui = readFileSync(
    path.join(process.cwd(), "src/components/registration-plan.tsx"),
    "utf8",
  );
  assert.doesNotMatch(ui, /python -m src\.main registration-plan/);
  assert.doesNotMatch(ui, /Run it in a terminal/);
  assert.match(ui, /useEffect/);
  assert.match(ui, /warehouse/);
});

test("documented carve-outs IL/NY are not register_now", () => {
  for (const state of ["IL", "NY"] as const) {
    const d = decide(tessFacts(state));
    assert.equal(d.action, "review_contested", state);
    assert.equal(d.documentation_status, "documented");
    assert.equal(d.confidence, "high");
    assert.equal(d.authority_source, "tess_packet");
    assert.equal(d.packet_date, TESS_PACKET_DATE);
    assert.doesNotMatch(d.citation, /35 ILCS 105\/2\(1\.1\)/);
  }
  const il = decide(tessFacts("IL"));
  assert.match(il.citation, /35 ILCS 105\/2\(1\)/);
  assert.match(il.citation, /131\.105/);
  const ny = decide(tessFacts("NY"));
  assert.match(ny.citation, /1101\(b\)\(8\)\(v\)/);
  assert.match(ny.citation, /TSB-A-24\(45\)S/);
});

test("documented asserts ID/LA/NM are register_now with citation", () => {
  const needles: Record<string, RegExp> = {
    ID: /63-3611\(3\)\(a\)/,
    LA: /47:301\(4\)\(h\)/,
    NM: /7-9-3\.3/,
  };
  for (const [state, needle] of Object.entries(needles)) {
    const d = decide(tessFacts(state));
    assert.equal(d.action, "register_now", state);
    assert.equal(d.documentation_status, "documented");
    assert.equal(d.confidence, "high");
    assert.equal(d.packet_date, TESS_PACKET_DATE);
    assert.match(d.citation, needle);
    assert.match(d.reason, /tess_packet/);
  }
});

test("partial MO/AL/MS/AZ are not register_now", () => {
  for (const state of ["MO", "AL", "MS"] as const) {
    const d = decide(tessFacts(state));
    assert.equal(d.action, "needs_statute_review", state);
    assert.equal(d.documentation_status, "partial");
    assert.match(d.reason, /partial — FBA not named; CPA confirm/);
  }
  const az = decide(tessFacts("AZ"));
  assert.equal(az.action, "review_contested");
  assert.equal(az.documentation_status, "partial");
  assert.match(az.citation, /ADOR FAQ/);
});

test("economic-only path is unchanged", () => {
  const d = decide(facts({ economic_exceeded: true, economic_pct: 145, amazon_sales: 250_000 }));
  assert.equal(d.action, "register_now");
  assert.equal(d.authority_source, "economic");
  assert.match(d.reason, /economic threshold exceeded/);
});

test("bundled Tess citations match config JSON", () => {
  const parent = path.join(process.cwd(), "..", "config", "fba_inventory_nexus_citations.json");
  if (!existsSync(parent)) return;
  const src = JSON.parse(readFileSync(parent, "utf8")) as {
    states: Record<string, { documentation_status: string; posture: string; short_citation: string }>;
  };
  const bundled = bundledCitations();
  for (const [sc, pkt] of Object.entries(src.states)) {
    assert.equal(bundled[sc]?.documentation_status, pkt.documentation_status, sc);
    assert.equal(bundled[sc]?.posture, pkt.posture, sc);
    assert.equal(bundled[sc]?.short_citation, pkt.short_citation, sc);
  }
  assert.doesNotMatch(src.states.IL.short_citation, /105\/2\(1\.1\)/);
});

test("Nexus card shows documentation status and Tess packet date", () => {
  const ui = readFileSync(
    path.join(process.cwd(), "src/components/registration-plan.tsx"),
    "utf8",
  );
  assert.match(ui, /documentation_status/);
  assert.match(ui, /2026-09-11/);
  assert.match(ui, /needs_statute_review/);
});
