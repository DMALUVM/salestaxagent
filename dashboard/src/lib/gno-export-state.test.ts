import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXPORT_NEEDED,
  QUIET,
  ackPayload,
  evaluateExportNeed,
  formatHoursAgo,
  formatNextReview,
  isDigestWindow,
  isReviewDue,
  p0Key,
  reviewWindowStart,
} from "./gno-export-state";
import { GNO_NEXT_REVIEW_AT } from "./gno-ppc-watch";

const P0 = { code: "KEEPER_MISSING", campaign_name: "Auto Loose", search_term: undefined };

describe("GNO export due-state", () => {
  test("P0 with no last export is EXPORT_NEEDED", () => {
    const b = evaluateExportNeed({
      now: new Date("2026-09-07T12:00:00-07:00"),
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0: [P0],
    });
    assert.equal(b.state, EXPORT_NEEDED);
    assert.deepEqual(b.reasons, ["P0"]);
    assert.match(b.headline, /Pack due — never exported/);
  });

  test("exporting acks current P0 until a new one appears", () => {
    const now = new Date("2026-09-07T15:00:00-07:00");
    const before = evaluateExportNeed({
      now,
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0: [P0],
    });
    const ack = ackPayload(before, [P0], [], "gno-pack-2026-09-06.zip", now);
    const after = evaluateExportNeed({
      now: new Date("2026-09-07T16:00:00-07:00"),
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0: [P0],
      lastExportAt: ack.last_export_at,
      ackedP0Keys: ack.acked_p0_keys,
    });
    assert.equal(after.state, QUIET);
    assert.match(after.headline, /Up to date/);

    const fresh = evaluateExportNeed({
      now: new Date("2026-09-07T16:00:00-07:00"),
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0: [P0, { code: "NEW_EXACT_BURN", campaign_name: "EX tallow", search_term: undefined }],
      lastExportAt: ack.last_export_at,
      ackedP0Keys: ack.acked_p0_keys,
    });
    assert.equal(fresh.state, EXPORT_NEEDED);
    assert.ok(fresh.reasons.includes("P0"));
    assert.match(fresh.headline, /last export/);
  });

  test("review is due within 6h and overdue, cleared by export after window opens", () => {
    const review = "2026-09-09T18:00:00-07:00";
    assert.equal(
      isReviewDue(new Date("2026-09-09T11:00:00-07:00"), review, null),
      false,
    );
    assert.equal(
      isReviewDue(new Date("2026-09-09T13:00:00-07:00"), review, null),
      true,
    );
    assert.equal(
      isReviewDue(new Date("2026-09-10T10:00:00-07:00"), review, null),
      true,
    );
    const start = reviewWindowStart(review);
    assert.ok(start);
    assert.equal(
      isReviewDue(new Date("2026-09-09T13:00:00-07:00"), review, "2026-09-08T10:00:00-07:00"),
      true,
    );
    assert.equal(
      isReviewDue(new Date("2026-09-09T13:30:00-07:00"), review, "2026-09-09T12:30:00-07:00"),
      false,
    );
  });

  test("digest only in 06:30–08:00 ET with new harvest/junk P1", () => {
    const p1 = [{ code: "HARVEST_CANDIDATE", search_term: "tallow lip balm organic" }];
    const inWindow = new Date("2026-09-08T07:00:00-04:00");
    const outside = new Date("2026-09-08T12:00:00-04:00");
    assert.equal(isDigestWindow(inWindow), true);
    assert.equal(isDigestWindow(outside), false);

    const due = evaluateExportNeed({
      now: inWindow,
      nextReviewAt: "2026-09-20T18:00:00-07:00",
      p0: [],
      p1,
    });
    assert.equal(due.state, EXPORT_NEEDED);
    assert.deepEqual(due.reasons, ["DIGEST"]);

    const quietOutside = evaluateExportNeed({
      now: outside,
      nextReviewAt: "2026-09-20T18:00:00-07:00",
      p0: [],
      p1,
    });
    assert.equal(quietOutside.state, QUIET);

    const acked = evaluateExportNeed({
      now: inWindow,
      nextReviewAt: "2026-09-20T18:00:00-07:00",
      p0: [],
      p1,
      lastExportAt: inWindow.toISOString(),
      ackedP1Keys: ["HARVEST_CANDIDATE|tallow lip balm organic"],
    });
    assert.equal(acked.state, QUIET);
  });

  test("nextReviewAt formats in Amazon PT and hours-ago copy", () => {
    const label = formatNextReview(GNO_NEXT_REVIEW_AT);
    assert.match(label, /Sep/);
    assert.match(label, /9/);
    assert.match(label, /2026/);
    assert.match(label, /6:00/);
    const ago = formatHoursAgo(
      "2026-09-07T00:00:00.000Z",
      new Date("2026-09-07T14:00:00.000Z"),
    );
    assert.equal(ago, "14h ago");
  });

  test("p0Key is stable after whitespace normalize", () => {
    assert.equal(
      p0Key({ code: "KEEPER_MISSING", campaign_name: "Auto  Loose", search_term: undefined }),
      p0Key({ code: "KEEPER_MISSING", campaign_name: "Auto Loose", search_term: undefined }),
    );
  });
});

describe("GNO export UI copy is wired", () => {
  test("banner + when-to-export sit on the watch page", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    assert.match(ui, /EXPORT NEEDED/);
    assert.match(ui, /When to Export GNO pack/);
    assert.match(ui, /Anytime a P0 fires/);
    assert.match(ui, /Wed evening ~48h review/);
    assert.match(ui, /Optional daily/);
    assert.match(ui, /export never writes to Amazon/);
    assert.match(ui, /data-export-state/);
    assert.match(ui, /Log Grok outcome/);
    assert.match(ui, /last call:/);
    assert.match(ui, /evaluateExportNeed/);
    assert.doesNotMatch(ui, /if \(error && !data\?\.newExact\?\.length\)/);
    assert.doesNotMatch(ui, /autoPause\(/);
  });
});
