import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BLEEDERS_10_CLICK_FLOOR,
  bleeders10ToCsv,
  isBleeders10Hit,
  resolveBleeders10Action,
  type Bleeders10CampaignRow,
  type Bleeders10TermRow,
} from "./ppc-bleeders-10";
import { buildBleeders10 } from "./ppc-bleeders-10-live";
import { buildBlake63dList } from "./ppc-weekly-blake-63d";

function term(partial: Partial<Bleeders10TermRow> = {}): Bleeders10TermRow {
  return {
    date: "2026-08-01",
    search_term: "beef tallow lip balm",
    campaign_id: "c1",
    campaign_name: "SP Exact",
    ad_group_id: "ag1",
    ad_group_name: "Exact",
    keyword: "beef tallow lip balm",
    match_type: "EXACT",
    spend: 12,
    sales_14d: 0,
    orders_14d: 0,
    clicks: 6,
    ...partial,
  };
}

function camp(partial: Partial<Bleeders10CampaignRow> = {}): Bleeders10CampaignRow {
  return {
    date: "2026-08-01",
    campaign_id: "c1",
    campaign_name: "SP Exact",
    campaign_type: "SP",
    campaign_status: "ENABLED",
    orders_14d: 8,
    clicks: 40,
    ...partial,
  };
}

describe("Bleeders 1.0 action split", () => {
  test("term equals exact keyword → pause_keyword; else negative_exact", () => {
    assert.equal(resolveBleeders10Action("EXACT", "deodorant men", "deodorant men"), "pause_keyword");
    assert.equal(resolveBleeders10Action("EXACT", "vanmans deodorant", "vanman deodorant"), "negative_exact");
    assert.equal(resolveBleeders10Action("BROAD", "coconut oil lip balm", "+lip +moisturizer"), "negative_exact");
    assert.equal(
      resolveBleeders10Action("TARGETING_EXPRESSION", "carpe deodorant", 'asin="B0CLHYY3BB"'),
      "negative_exact",
    );
    assert.equal(
      resolveBleeders10Action("TARGETING_EXPRESSION", 'asin="B0CLHYY3BB"', 'asin="B0CLHYY3BB"'),
      null,
      "TARGETING query = expression is not 1.0",
    );
  });
});

describe("Bleeders 1.0 flag rule", () => {
  test("clicks=5 $0 is not a hit; clicks=6 $0 is", () => {
    assert.equal(isBleeders10Hit(5, 0, 0), false);
    assert.equal(isBleeders10Hit(6, 0, 0), true);
    assert.equal(BLEEDERS_10_CLICK_FLOOR, 6);
  });

  test("converting terms are not hits", () => {
    assert.equal(isBleeders10Hit(20, 10, 1), false);
    assert.equal(isBleeders10Hit(20, 0.01, 0), false);
    assert.equal(isBleeders10Hit(20, 0, 1), false);
  });
});

describe("Bleeders 1.0 live triage — not a pasted execute list", () => {
  test("clicks=5 $0 is not flagged; clicks=6 $0 is", () => {
    const five = buildBleeders10({
      termRows: [term({ clicks: 5, spend: 9 })],
      campaignRows: [camp()],
    });
    assert.equal(five.rows.length, 0);

    const six = buildBleeders10({
      termRows: [term({ clicks: 6, spend: 12 })],
      campaignRows: [camp()],
    });
    assert.equal(six.rows.length, 1);
    assert.equal(six.rows[0].clicks, 6);
    assert.equal(six.rows[0].sales_14d, 0);
    assert.equal(six.kind, "triage");
    assert.equal(six.click_floor, 6);
  });

  test("two sparse days summing to 6 clicks flag; 5 do not", () => {
    const hit = buildBleeders10({
      termRows: [
        term({ date: "2026-07-01", clicks: 3, spend: 5 }),
        term({ date: "2026-07-10", clicks: 3, spend: 5 }),
      ],
      campaignRows: [camp({ date: "2026-07-01" }), camp({ date: "2026-07-10" })],
    });
    assert.equal(hit.rows.length, 1);
    assert.equal(hit.rows[0].clicks, 6);

    const miss = buildBleeders10({
      termRows: [
        term({ date: "2026-07-01", clicks: 3, spend: 5 }),
        term({ date: "2026-07-10", clicks: 2, spend: 4 }),
      ],
      campaignRows: [camp({ date: "2026-07-01" }), camp({ date: "2026-07-10" })],
    });
    assert.equal(miss.rows.length, 0);
  });

  test("sales or orders on the term drop it", () => {
    const sold = buildBleeders10({
      termRows: [term({ clicks: 20, sales_14d: 14, orders_14d: 1 })],
      campaignRows: [camp()],
    });
    assert.equal(sold.rows.length, 0);
  });

  test("term=exact KW → pause_keyword; else negative_exact", () => {
    const pause = buildBleeders10({
      termRows: [term({ search_term: "deodorant men", keyword: "deodorant men", match_type: "EXACT" })],
      campaignRows: [camp()],
    });
    assert.equal(pause.rows[0]?.action, "pause_keyword");

    const neg = buildBleeders10({
      termRows: [term({
        search_term: "vanmans deodorant",
        keyword: "vanman deodorant",
        match_type: "EXACT",
        clicks: 8,
      })],
      campaignRows: [camp()],
    });
    assert.equal(neg.rows[0]?.action, "negative_exact");
  });

  test("skips branded $0 (primal essence / tallowbourne)", () => {
    const out = buildBleeders10({
      termRows: [
        term({ search_term: "primal essence deodorant", keyword: "primal essence deodorant", clicks: 20, spend: 40 }),
        term({ search_term: "tallowbourne deodorant", keyword: "tallowbourne deodorant", clicks: 18, spend: 30 }),
        term({ search_term: "beef tallow lip balm", clicks: 6, spend: 12 }),
      ],
      campaignRows: [camp()],
    });
    const terms = out.rows.map((r) => r.search_term.toLowerCase());
    assert.equal(terms.includes("primal essence deodorant"), false);
    assert.equal(terms.includes("tallowbourne deodorant"), false);
    assert.equal(terms.includes("beef tallow lip balm"), true);
  });

  test("paused, SB, and missing campaigns are excluded", () => {
    const out = buildBleeders10({
      termRows: [
        term({ campaign_id: "paused", search_term: "paused term", keyword: "paused term", clicks: 10 }),
        term({ campaign_id: "sb1", search_term: "sb term", keyword: "sb term", clicks: 10 }),
        term({ campaign_id: "ghost", search_term: "ghost term", keyword: "ghost term", clicks: 10 }),
        term({ campaign_id: "c1", clicks: 6 }),
      ],
      campaignRows: [
        camp({ campaign_id: "paused", campaign_status: "PAUSED" }),
        camp({ campaign_id: "sb1", campaign_type: "SB" }),
        camp({ campaign_id: "c1" }),
      ],
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].campaign_id, "c1");
  });

  test("account CVR comes from campaigns, not a hardcoded 25%", () => {
    const out = buildBleeders10({
      termRows: [term()],
      campaignRows: [camp({ orders_14d: 8, clicks: 40 })],
    });
    assert.equal(out.account_cvr, 20);
    assert.equal(out.account_cvr_source, "ads_campaigns_daily");
    assert.notEqual(out.account_cvr, 25.79);
    assert.match(out.title, /CVR 20%/);
    assert.ok(out.notes.some((n) => /not a hardcoded 25%/.test(n)));
  });

  test("window label is stored min/max + days-with-rows, not 90d", () => {
    const out = buildBleeders10({
      termRows: [
        term({ date: "2026-07-01", clicks: 3, spend: 5 }),
        term({ date: "2026-07-10", clicks: 3, spend: 5 }),
      ],
      campaignRows: [camp({ date: "2026-07-01" }), camp({ date: "2026-07-10" })],
    });
    assert.equal(out.window.window_start, "2026-07-01");
    assert.equal(out.window.window_end, "2026-07-10");
    assert.equal(out.window.window_days, 10);
    assert.equal(out.window.days_with_rows, 2);
    assert.match(out.window.label, /2026-07-01 → 2026-07-10/);
    assert.match(out.window.label, /10d stored/);
    assert.match(out.window.label, /2 days with rows/);
    assert.match(out.window.label, /not 90d/);
    assert.doesNotMatch(out.title, /90d/);
    assert.match(out.title, /floor 6/);
    assert.match(out.title, /2026-07-01\.\.2026-07-10/);
  });

  test("pull order is spend then clicks — not a Blake execute rank", () => {
    const out = buildBleeders10({
      termRows: [
        term({ search_term: "cheap miss", keyword: "cheap miss", clicks: 20, spend: 8 }),
        term({ search_term: "expensive miss", keyword: "expensive miss", clicks: 8, spend: 40 }),
      ],
      campaignRows: [camp()],
    });
    assert.equal(out.rows[0].search_term, "expensive miss");
    assert.equal(out.rows[0].rank, 1);
    assert.equal(out.rows[1].search_term, "cheap miss");
    assert.equal(out.rows[1].rank, 2);
  });

  test("Done/Skipped from decisions persist on $0 rows", () => {
    const open = buildBleeders10({
      termRows: [term({ search_term: "deodorant men", keyword: "deodorant men" })],
      campaignRows: [camp()],
    });
    const id = open.rows[0].checklist_id;
    const marked = buildBleeders10({
      termRows: [term({ search_term: "deodorant men", keyword: "deodorant men" })],
      campaignRows: [camp()],
      decisions: [{
        id: "dec-1",
        entity_name: id,
        search_term: "deodorant men",
        action_type: "pause_keyword",
        rec_type: "BLEEDER_PAUSE_KEYWORD",
        campaign_id: "c1",
        status: "applied",
      }],
    });
    assert.equal(marked.rows[0].status, "done");
    assert.equal(marked.done_count, 1);
    assert.equal(marked.open_count, 0);
  });

  test("CSV is a structured pull with window columns", () => {
    const out = buildBleeders10({
      termRows: [term({ search_term: "deodorant men", keyword: "deodorant men", clicks: 6, spend: 12.5 })],
      campaignRows: [camp()],
    });
    const csv = bleeders10ToCsv(out);
    assert.match(csv, /pull_order,action,campaign/);
    assert.match(csv, /deodorant men/);
    assert.match(csv, /window_start/);
    assert.match(csv, /2026-08-01/);
    assert.doesNotMatch(csv, /undefined/);
  });
});

describe("This week 63d execute list is unchanged", () => {
  test("buildBlake63dList is still This week and is not a live 1.0 rank", () => {
    const week = buildBlake63dList();
    assert.equal(week.execute_list, "blake_63d");
    assert.ok(week.rows.length > 10, "63d execute list is larger than a 10-row paste");
    assert.equal(week.click_floor, 10);
    assert.ok(week.rows.some((r) => r.action === "bid_down"), "63d still has bid_down");
  });

  test("GET ships bleeders10 as live triage and bleeders as Blake 63d", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    const client = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders-10.tsx"), "utf8");
    const types = readFileSync(path.join(process.cwd(), "src/lib/ppc-bleeders-10.ts"), "utf8");
    assert.match(route, /from "@\/lib\/ppc-bleeders-10-live"/);
    assert.match(route, /buildBleeders10\s*\(\s*\{/);
    assert.match(route, /termRows:/);
    assert.match(route, /campaignRows:\s*allCampaignRows/);
    assert.match(route, /bleeders10/);
    assert.match(route, /buildBlake63dList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.doesNotMatch(route, /from "@\/lib\/ppc-bleeders"/);
    assert.match(page, /PpcBleeders10/);
    assert.match(page, /Bleeders 1\.0/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /This week/);
    assert.match(page, /useState<"search" \| "campaigns" \| "bleeders">\("bleeders"\)/);
    assert.doesNotMatch(client, /ppc-bleeders-10-live|brand-terms|node:fs/);
    assert.doesNotMatch(types, /brand-terms|node:fs|buildBleeders10/);
  });
});
