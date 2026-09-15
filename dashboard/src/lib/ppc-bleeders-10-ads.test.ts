import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildBleeders10 } from "./ppc-bleeders-10";
import {
  adsSnapshotFromWarehouse,
  reconcileBleeders10Row,
  summarizeBleeders10Ads,
} from "./ppc-bleeders-10-ads";

const NOW = "2026-09-15T15:00:00Z";
const PULLED = "2026-09-15T12:00:00Z";
const STALE = "2026-09-12T12:00:00Z";

const CARPE_CAMP = "GG - B0CLHYY3BB - Deodorant - Asin Defense";

function adsWith(partial: {
  negatives?: Parameters<typeof adsSnapshotFromWarehouse>[0]["negatives"];
  keywords?: Parameters<typeof adsSnapshotFromWarehouse>[0]["keywords"];
  campaigns?: Parameters<typeof adsSnapshotFromWarehouse>[0]["campaigns"];
  pulled?: string;
}) {
  const pulled = partial.pulled ?? PULLED;
  return adsSnapshotFromWarehouse({
    now: NOW,
    campaigns: partial.campaigns,
    negatives: (partial.negatives ?? []).map((n) => ({ snapshot_at: pulled, ...n })),
    keywords: (partial.keywords ?? []).map((k) => ({ snapshot_at: pulled, ...k })),
  });
}

describe("Bleeders 1.0 Ads-truth reconcile matcher", () => {
  test("carpe deodorant negative exact on Rank 2 campaign leaves Open", () => {
    const ads = adsWith({
      negatives: [{
        campaign_name: CARPE_CAMP,
        keyword: "Carpe Deodorant",
        match_type: "NEGATIVE_EXACT",
        state: "ENABLED",
        level: "campaign",
      }],
      keywords: [{
        campaign_name: CARPE_CAMP,
        keyword_text: "unrelated",
        match_type: "EXACT",
        state: "ENABLED",
      }],
    });
    const out = buildBleeders10({ ads });
    const carpe = out.rows.find((r) => r.search_term === "carpe deodorant");
    assert.ok(carpe);
    assert.equal(carpe?.action, "negative_exact");
    assert.equal(carpe?.status, "already_applied");
    assert.equal(carpe?.applied_source, "ads_negatives");
    assert.match(carpe?.applied_reason ?? "", /Found negative exact in ads_negatives/);
    assert.match(carpe?.applied_reason ?? "", /pulled_at/);
    assert.equal(out.rows.filter((r) => r.status === "open").length, out.open_count);
    assert.equal(out.rows.some((r) => r.status === "open" && r.search_term === "carpe deodorant"), false);
    assert.equal(out.already_applied_count, 1);
    assert.equal(out.open_count, 9);
  });

  test("case and spacing normalize on the search term", () => {
    const hit = reconcileBleeders10Row({
      action: "negative_exact",
      campaign_name: CARPE_CAMP,
      search_term: "carpe deodorant",
      keyword: 'asin="B0CLHYY3BB"',
    }, adsWith({
      negatives: [{
        campaign_name: `  ${CARPE_CAMP} `,
        keyword: "  CARPE   deodorant ",
        match_type: "exact",
        state: "enabled",
        level: "ad_group",
      }],
    }));
    assert.equal(hit.applied, true);
    assert.equal(hit.source, "ads_negatives");
  });

  test("phrase / other-campaign / paused negatives do not close the row", () => {
    const out = buildBleeders10({
      ads: adsWith({
        negatives: [
          { campaign_name: CARPE_CAMP, keyword: "carpe deodorant", match_type: "NEGATIVE_PHRASE", state: "ENABLED" },
          { campaign_name: "Some other campaign", keyword: "carpe deodorant", match_type: "EXACT", state: "ENABLED" },
          { campaign_name: CARPE_CAMP, keyword: "carpe deodorant", match_type: "EXACT", state: "PAUSED" },
        ],
        keywords: [{ campaign_name: CARPE_CAMP, keyword_text: "x", match_type: "EXACT", state: "ENABLED" }],
      }),
    });
    const carpe = out.rows.find((r) => r.search_term === "carpe deodorant");
    assert.equal(carpe?.status, "open");
    assert.equal(carpe?.applied_source, null);
  });

  test("pause_keyword is already_applied when Exact KW is PAUSED or ARCHIVED", () => {
    const paused = buildBleeders10({
      ads: adsWith({
        keywords: [{
          campaign_name: "GG - Deodorant - Exact - SQR - CST",
          keyword_text: "deodorant men",
          match_type: "EXACT",
          state: "PAUSED",
        }],
      }),
    });
    assert.equal(paused.rows[0].status, "already_applied");
    assert.equal(paused.rows[0].applied_source, "ads_keyword_targets");
    assert.match(paused.rows[0].applied_reason ?? "", /paused in ads_keyword_targets/i);

    const archived = buildBleeders10({
      ads: adsWith({
        keywords: [{
          campaign_name: "GG - Deodorant - Exact - SQR - CST",
          keyword_text: "Deodorant Men",
          match_type: "exact",
          state: "ARCHIVED",
        }],
      }),
    });
    assert.equal(archived.rows[0].status, "already_applied");
    assert.match(archived.rows[0].applied_reason ?? "", /archived/i);
  });

  test("enabled Exact KW stays Open — do not invent a pause", () => {
    const out = buildBleeders10({
      ads: adsWith({
        keywords: [{
          campaign_name: "GG - Deodorant - Exact - SQR - CST",
          keyword_text: "deodorant men",
          match_type: "EXACT",
          state: "ENABLED",
        }],
      }),
    });
    assert.equal(out.rows[0].status, "open");
    assert.equal(out.rows[0].applied_reason, null);
  });

  test("manual Done/Skipped win over Ads hits", () => {
    const ads = adsWith({
      negatives: [{
        campaign_name: CARPE_CAMP,
        keyword: "carpe deodorant",
        match_type: "EXACT",
        state: "ENABLED",
      }],
    });
    const skipped = buildBleeders10({
      ads,
      decisions: [{
        search_term: "carpe deodorant",
        action_type: "negative_exact",
        campaign_id: CARPE_CAMP,
        status: "dismissed",
        id: "skip-1",
      }],
    });
    const row = skipped.rows.find((r) => r.search_term === "carpe deodorant");
    assert.equal(row?.status, "skipped");
    assert.equal(row?.applied_source, "manual");

    const done = buildBleeders10({
      ads,
      decisions: [{
        search_term: "carpe deodorant",
        action_type: "negative_exact",
        campaign_id: CARPE_CAMP,
        status: "applied",
        id: "done-1",
      }],
    });
    assert.equal(done.rows.find((r) => r.search_term === "carpe deodorant")?.status, "done");
  });

  test("missing snapshot warns and leaves rows Open", () => {
    const out = buildBleeders10();
    assert.equal(out.ads_snapshot.missing, true);
    assert.match(out.ads_snapshot.warning ?? "", /Cannot detect already-applied/);
    assert.equal(out.open_count, 10);
    assert.equal(out.already_applied_count, 0);
    assert.ok(out.rows.every((r) => r.status === "open"));
    assert.ok(out.rows.every((r) => r.ads_verify_note));
  });

  test("stale snapshot warns without silently closing rows", () => {
    const ads = adsWith({
      pulled: STALE,
      keywords: [{
        campaign_name: "GG - Deodorant - Exact - SQR - CST",
        keyword_text: "deodorant men",
        match_type: "EXACT",
        state: "ENABLED",
      }],
    });
    const summary = summarizeBleeders10Ads(ads, NOW);
    assert.equal(summary.stale, true);
    assert.match(summary.warning ?? "", /older than 48h/);
    const out = buildBleeders10({ ads });
    assert.equal(out.ads_snapshot.stale, true);
    assert.equal(out.rows[0].status, "open");
    assert.match(out.rows[0].ads_verify_note ?? "", /older than 48h|verify in Ads/i);
  });

  test("campaign with no snapshot rows gets a per-row verify note", () => {
    const ads = adsWith({
      keywords: [{
        campaign_name: "Unrelated campaign",
        keyword_text: "foo",
        match_type: "EXACT",
        state: "ENABLED",
      }],
    });
    const out = buildBleeders10({ ads });
    const carpe = out.rows.find((r) => r.search_term === "carpe deodorant");
    assert.equal(carpe?.status, "open");
    assert.match(carpe?.ads_verify_note ?? "", /No keyword or negative snapshot rows for this campaign/);
  });

  test("campaign id from ads_campaign_meta still matches a nameless negative", () => {
    const ads = adsWith({
      campaigns: [{ campaign_id: "111", campaign_name: CARPE_CAMP }],
      negatives: [{
        campaign_id: "111",
        campaign_name: "",
        keyword: "carpe deodorant",
        match_type: "EXACT",
        state: "ENABLED",
        level: "campaign",
      }],
    });
    const carpe = buildBleeders10({ ads }).rows.find((r) => r.search_term === "carpe deodorant");
    assert.equal(carpe?.status, "already_applied");
  });
});

describe("Bleeders 1.0 Ads reconcile wiring", () => {
  test("GET /api/ppc loads ads_negatives and ads_keyword_targets", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    assert.match(route, /ads_negatives/);
    assert.match(route, /ads_keyword_targets/);
    assert.match(route, /loadBleeders10AdsSnapshot/);
    assert.match(route, /buildBleeders10\s*\(\s*\{\s*decisions,\s*ads/);
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders-10.tsx"), "utf8");
    assert.match(ui, /already_applied/);
    assert.match(ui, /Already applied in Ads/);
    assert.match(ui, /ads_snapshot/);
  });
});
