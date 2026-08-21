import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HORIZON_DAYS, filterObligations, horizonDays, scopeStates,
  withinHorizon, type ObligationLike,
} from "./entity-filters";

const TODAY = "2026-08-20";

function ob(state: string, due: string | null, status = "open"): ObligationLike {
  return { state_code: state, due_date: due, status };
}

describe("horizon days", () => {
  test("default is twelve months", () => {
    assert.equal(DEFAULT_HORIZON_DAYS, 365);
    assert.equal(horizonDays(null), 365);
  });

  test("known keys", () => {
    assert.equal(horizonDays("12m"), 365);
    assert.equal(horizonDays("24m"), 730);
    assert.equal(horizonDays("all"), null);
  });
});

describe("withinHorizon", () => {
  test("inside the window", () => {
    assert.equal(withinHorizon("2027-04-20", TODAY, 365), true); // 243d
  });

  test("the 609-day row the user complained about is out", () => {
    assert.equal(withinHorizon("2028-04-20", TODAY, 365), false);
  });

  test("visible at 24 months", () => {
    assert.equal(withinHorizon("2028-04-20", TODAY, 730), true);
  });

  test("overdue always shows", () => {
    assert.equal(withinHorizon("2020-01-01", TODAY, 365), true);
  });

  test("all horizon includes everything", () => {
    assert.equal(withinHorizon("2099-01-01", TODAY, null), true);
  });

  test("a missing due date is never hidden", () => {
    assert.equal(withinHorizon(null, TODAY, 365), true);
  });
});

describe("scopeStates", () => {
  const REG = new Set(["HI", "NV", "TX"]);

  test("all has no restriction", () => {
    assert.equal(scopeStates("all", REG, "MD", new Set(["OK"])), null);
  });

  test("home + foreign only", () => {
    const s = scopeStates("home_foreign", REG, "MD", new Set(["OK"]));
    assert.deepEqual([...s!].sort(), ["MD", "OK"]);
  });

  test("registered unions home and foreign so MD/OK never vanish", () => {
    const s = scopeStates("registered", REG, "MD", new Set(["OK"]));
    assert.deepEqual([...s!].sort(), ["HI", "MD", "NV", "OK", "TX"]);
  });
});

describe("filterObligations", () => {
  const rows = [
    ob("MD", "2026-04-15"),               // overdue
    ob("MD", "2027-04-15"),               // 238d
    ob("HI", "2027-04-20"),               // 243d
    ob("HI", "2028-04-20"),               // 609d
    ob("OK", null),                       // needs a date
    ob("OK", "2026-02-25", "filed"),      // settled
  ];

  test("default horizon hides the 2028 row and says how many", () => {
    const r = filterObligations(rows, TODAY);
    assert.equal(r.counts.upcoming, 2);
    assert.equal(r.hiddenByHorizon, 1);
    assert.ok(!r.upcoming.some((x) => x.due_date === "2028-04-20"));
  });

  test("24 months reveals it", () => {
    const r = filterObligations(rows, TODAY, { horizon: "24m" });
    assert.equal(r.counts.upcoming, 3);
    assert.equal(r.hiddenByHorizon, 0);
  });

  test("overdue survives every horizon", () => {
    for (const h of ["12m", "24m", "all"] as const) {
      assert.equal(filterObligations(rows, TODAY, { horizon: h }).counts.overdue, 1);
    }
  });

  test("settled rows are separated and never counted as due", () => {
    const r = filterObligations(rows, TODAY, { horizon: "all" });
    assert.equal(r.counts.settled, 1);
    assert.ok(!r.overdue.some((x) => x.status === "filed"));
  });

  test("needsDate ignores the horizon", () => {
    assert.equal(filterObligations(rows, TODAY).counts.needsDate, 1);
  });

  test("registered scope keeps home and foreign states", () => {
    const r = filterObligations(rows, TODAY, {
      horizon: "all", scope: "registered",
      registered: new Set(["HI"]), homeState: "MD", foreignStates: new Set(["OK"]),
    });
    const states = new Set([...r.overdue, ...r.upcoming, ...r.needsDate].map((x) => x.state_code));
    assert.deepEqual([...states].sort(), ["HI", "MD", "OK"]);
  });

  test("home_foreign scope drops registered-only states", () => {
    const r = filterObligations(rows, TODAY, {
      horizon: "all", scope: "home_foreign",
      registered: new Set(["HI"]), homeState: "MD", foreignStates: new Set(["OK"]),
    });
    const states = new Set([...r.overdue, ...r.upcoming, ...r.needsDate].map((x) => x.state_code));
    assert.ok(!states.has("HI"));
  });

  test("upcoming is sorted by due date", () => {
    const r = filterObligations(rows, TODAY, { horizon: "all" });
    const dues = r.upcoming.map((x) => x.due_date);
    assert.deepEqual(dues, [...dues].sort());
  });
});
