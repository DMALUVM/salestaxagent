import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXPORT_NEEDED,
  QUIET,
  ackPayload,
  evaluateExportNeed,
  exportBannerFromState,
  formatHoursAgo,
  formatNextReview,
  isDigestWindow,
  isReviewDue,
  mergeGnoAdsOntoState,
  p0Key,
  resolveGnoReviewClock,
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

describe("live Wednesday review clock", () => {
  test("hardcoded Sep 9 seed does not force perpetual REVIEW after next Wed is computed", () => {
    const fri = new Date("2026-09-11T10:00:00-07:00");
    const covered = resolveGnoReviewClock(fri, "2026-09-09T13:00:00-07:00");
    assert.match(covered.nextReviewAt, /2026-09-16T18:00:00/);
    assert.equal(covered.reviewOverdue, false);
    const banner = evaluateExportNeed({
      now: fri,
      nextReviewAt: covered.nextReviewAt,
      upcomingReviewAt: covered.upcomingReviewAt,
      p0: [],
      lastExportAt: "2026-09-09T13:00:00-07:00",
      lastExportReason: "REVIEW",
    });
    assert.equal(banner.reviewDue, false);
    assert.equal(banner.state, QUIET);
    assert.doesNotMatch(banner.reviewLine, /Sep 9/);
    assert.match(banner.upcomingReviewLabel, /Sep 16/);
    assert.equal(GNO_NEXT_REVIEW_AT, "2026-09-09T18:00:00-07:00");
    assert.equal(
      isReviewDue(fri, GNO_NEXT_REVIEW_AT, "2026-09-09T13:00:00-07:00"),
      false,
    );
  });

  test("next Wed advances after a REVIEW export covering this week's window", () => {
    const thu = new Date("2026-09-10T09:00:00-07:00");
    const before = resolveGnoReviewClock(thu, "2026-09-08T10:00:00-07:00");
    assert.match(before.nextReviewAt, /2026-09-09T18:00:00/);
    assert.equal(before.reviewOverdue, true);
    const after = resolveGnoReviewClock(thu, "2026-09-09T19:00:00-07:00");
    assert.match(after.nextReviewAt, /2026-09-16T18:00:00/);
    assert.equal(after.reviewOverdue, false);
    const due = exportBannerFromState({
      last_export_at: "2026-09-09T19:00:00-07:00",
      last_export_reason: "REVIEW",
    }, { now: thu });
    assert.equal(due.reviewDue, false);
    assert.match(due.upcomingReviewAt, /2026-09-16/);
  });

  test("Fri Sep 11 without covering export says overdue, not Next: Sep 9", () => {
    const fri = new Date("2026-09-11T15:00:00-07:00");
    const clock = resolveGnoReviewClock(fri, "2026-09-07T12:00:00-07:00");
    const banner = evaluateExportNeed({
      now: fri,
      nextReviewAt: clock.nextReviewAt,
      upcomingReviewAt: clock.upcomingReviewAt,
      p0: [],
      lastExportAt: "2026-09-07T12:00:00-07:00",
    });
    assert.equal(banner.state, EXPORT_NEEDED);
    assert.ok(banner.reasons.includes("REVIEW"));
    assert.equal(banner.reviewOverdue, true);
    assert.match(banner.headline, /overdue/);
    assert.match(banner.headline, /last export/);
    assert.doesNotMatch(banner.headline, /never exported/);
    assert.match(banner.reviewLine, /overdue/);
    assert.doesNotMatch(banner.reviewLine, /^Next human review:.*Sep 9/);
    assert.match(banner.upcomingReviewLabel, /Sep 16/);
  });

  test("Wed morning still owes last week's REVIEW until an export covers it", () => {
    const wedAm = new Date("2026-09-16T10:00:00-07:00");
    const unpaid = resolveGnoReviewClock(wedAm, null);
    assert.match(unpaid.nextReviewAt, /2026-09-09T18:00:00/);
    assert.equal(unpaid.reviewOverdue, true);
    assert.match(unpaid.upcomingReviewAt, /2026-09-16T18:00:00/);
    const paid = resolveGnoReviewClock(wedAm, "2026-09-09T19:00:00-07:00");
    assert.match(paid.nextReviewAt, /2026-09-16T18:00:00/);
    assert.equal(paid.reviewOverdue, false);
  });

  test("Sunday still resolves this week's Wednesday, not next week's", () => {
    const sun = new Date("2026-09-13T10:00:00-07:00");
    const clock = resolveGnoReviewClock(sun, "2026-09-09T19:00:00-07:00");
    assert.match(clock.nextReviewAt, /2026-09-16T18:00:00/);
    const unpaid = resolveGnoReviewClock(sun, null);
    assert.match(unpaid.nextReviewAt, /2026-09-09T18:00:00/);
    assert.equal(unpaid.reviewOverdue, true);
  });

  test("never exported only when last_export_at is missing", () => {
    const fri = new Date("2026-09-11T15:00:00-07:00");
    const missing = exportBannerFromState(null, { now: fri });
    assert.match(missing.headline, /never exported|needs export/);
    const present = exportBannerFromState({
      last_export_at: "2026-09-08T08:00:00-07:00",
    }, { now: fri });
    assert.match(present.headline, /last export/i);
    assert.doesNotMatch(present.headline, /never exported/);
  });
});

describe("ads timeout preserves lastExportAt", () => {
  test("merge keeps store lastExportAt when ads payload omits it", () => {
    const fri = new Date("2026-09-11T15:00:00-07:00");
    const stateBanner = exportBannerFromState({
      last_export_at: "2026-09-10T12:00:00-07:00",
      last_export_reason: "P0",
    }, { now: fri });
    const merged = mergeGnoAdsOntoState({
      lastExportAt: "2026-09-10T12:00:00-07:00",
      lastExportReason: "P0",
      exportBanner: stateBanner,
      nextReviewAt: stateBanner.nextReviewAt,
    }, {
      error: "GNO Watch timed out loading ads.",
      lastExportAt: null,
      exportBanner: undefined,
    });
    assert.equal(merged.lastExportAt, "2026-09-10T12:00:00-07:00");
    assert.ok(merged.exportBanner);
    assert.equal(merged.exportBanner.lastExportAt, "2026-09-10T12:00:00-07:00");
    assert.doesNotMatch(merged.exportBanner.headline, /never exported/);
  });
});

describe("GNO export UI copy is wired", () => {
  test("banner + when-to-export sit on the watch page", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    assert.match(ui, /EXPORT NEEDED/);
    assert.match(ui, /When to Export GNO pack/);
    assert.match(ui, /Anytime a P0 fires/);
    assert.match(ui, /Every Wednesday evening ~48h review/);
    assert.match(ui, /Optional Mon\/Wed\/Fri morning digest/);
    assert.match(ui, /export never writes to Amazon/);
    assert.match(ui, /data-export-state/);
    assert.match(ui, /Log Grok outcome/);
    assert.match(ui, /last call:/);
    assert.match(ui, /exportBannerFromState/);
    assert.match(ui, /\/api\/ppc\/gno-state/);
    assert.match(ui, /campaign L2/);
    assert.match(ui, /search-term files/);
    assert.doesNotMatch(ui, /2026-09-09T18:00:00/);
    assert.doesNotMatch(ui, /Optional daily/);
    assert.doesNotMatch(ui, /if \(error && !data\?\.newExact\?\.length\)/);
    assert.doesNotMatch(ui, /autoPause\(/);
    assert.doesNotMatch(ui, /evaluateExportNeed/);
    const howto = ui.slice(ui.indexOf("When to Export GNO pack"));
    assert.doesNotMatch(howto.slice(0, 800), /2026-09-09/);
  });
});
