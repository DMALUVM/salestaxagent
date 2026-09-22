import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildIntel } from "./intel";
import { buildMetaCallSheet, metaDigestActions } from "./meta-call";
import type { CampaignDaily, MetaGrainRow } from "./types";

function camp(
  partial: Partial<CampaignDaily> & Pick<CampaignDaily, "date" | "campaign_name" | "spend">,
): CampaignDaily {
  return {
    platform: "meta",
    campaign_type: "Other",
    product: "balm",
    is_brand: false,
    audience: "prospect",
    conv_value: 0,
    clicks: 10,
    impressions: 400,
    conversions: 0,
    lost_is_budget: null,
    lost_is_rank: null,
    frequency: null,
    frequency_peak: null,
    status: "ACTIVE",
    ...partial,
  };
}

function grain(
  partial: Partial<MetaGrainRow> & Pick<MetaGrainRow, "date" | "entity_name">,
): MetaGrainRow {
  return {
    grain: "adset",
    campaign_name: "UGC Balm",
    spend: 0,
    conv_value: 0,
    clicks: 10,
    impressions: 400,
    conversions: 0,
    frequency: null,
    reach: null,
    ctr: null,
    add_to_cart: null,
    initiate_checkout: null,
    ...partial,
  };
}

/** Spread one window total across 7 consecutive days ending on `end`. */
function week(
  end: string,
  extra: Omit<Partial<CampaignDaily>, "date"> & Pick<CampaignDaily, "campaign_name">,
  days = 7,
): CampaignDaily[] {
  const spend = (extra.spend ?? 0) / days;
  const value = (extra.conv_value ?? 0) / days;
  const conv = (extra.conversions ?? 0) / days;
  const clicks = (extra.clicks ?? 70) / days;
  const impr = (extra.impressions ?? 2800) / days;
  const out: CampaignDaily[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(`${end}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(camp({
      ...extra,
      date: d.toISOString().slice(0, 10),
      spend,
      conv_value: value,
      conversions: conv,
      clicks,
      impressions: impr,
    }));
  }
  return out;
}

function weekGrain(
  end: string,
  extra: Omit<Partial<MetaGrainRow>, "date"> & Pick<MetaGrainRow, "entity_name">,
  days = 7,
): MetaGrainRow[] {
  const spend = (extra.spend ?? 0) / days;
  const value = (extra.conv_value ?? 0) / days;
  const conv = (extra.conversions ?? 0) / days;
  const clicks = (extra.clicks ?? 70) / days;
  const impr = (extra.impressions ?? 2800) / days;
  const out: MetaGrainRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(`${end}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(grain({
      ...extra,
      date: d.toISOString().slice(0, 10),
      spend,
      conv_value: value,
      conversions: conv,
      clicks,
      impressions: impr,
    }));
  }
  return out;
}

describe("buildMetaCallSheet", () => {
  test("empty as-of invents nothing", () => {
    assert.deepEqual(buildMetaCallSheet({ campaigns: [], asOf: null }), {
      as_of: null, items: [],
    });
  });

  test("skips sub-dollar spend and never parks leftover on Brand Search", () => {
    const sheet = buildMetaCallSheet({
      campaigns: week("2026-09-21", {
        campaign_name: "Tiny", spend: 0.8, conv_value: 0, conversions: 0,
      }),
      asOf: "2026-09-21",
    });
    assert.equal(sheet.items.length, 0);
    const kill = buildMetaCallSheet({
      campaigns: week("2026-09-21", {
        campaign_name: "Dead Prospect", spend: 20, conv_value: 0, conversions: 0,
      }),
      asOf: "2026-09-21",
    });
    assert.equal(kill.items[0]?.action, "kill");
    assert.match(kill.items[0]?.say ?? "", /Pause Dead Prospect/);
    assert.doesNotMatch(kill.items.map((i) => `${i.say} ${i.why}`).join("\n"), /Brand Search/);
  });

  test("ranks kill, cut, scale, keep, refresh from last-7 vs prior-7", () => {
    const campaigns = [
      ...week("2026-09-21", {
        campaign_name: "Dead UGC", spend: 20, conv_value: 0, conversions: 0,
      }),
      ...week("2026-09-21", {
        campaign_name: "Weak Retarget", spend: 30, conv_value: 12, conversions: 1,
      }),
      ...week("2026-09-21", {
        campaign_name: "Winner Balm", spend: 40, conv_value: 80, conversions: 4,
      }),
      ...week("2026-09-14", {
        campaign_name: "Winner Balm", spend: 35, conv_value: 60, conversions: 3,
      }),
      ...week("2026-09-21", {
        campaign_name: "Steady Keep", spend: 8, conv_value: 16, conversions: 1,
      }),
    ];
    const ads = [
      ...weekGrain("2026-09-21", {
        grain: "ad", campaign_name: "Fatigue", entity_name: "Hook A",
        spend: 18, conv_value: 6, conversions: 1, ctr: 0.6, impressions: 4000,
      }),
      ...weekGrain("2026-09-14", {
        grain: "ad", campaign_name: "Fatigue", entity_name: "Hook A",
        spend: 16, conv_value: 8, conversions: 1, ctr: 2.0, impressions: 4000,
      }),
    ];
    const sheet = buildMetaCallSheet({
      campaigns: [
        ...campaigns,
        ...week("2026-09-21", {
          campaign_name: "Fatigue", spend: 18, conv_value: 6, conversions: 1,
        }),
      ],
      ads,
      asOf: "2026-09-21",
    });
    const byAction = Object.fromEntries(sheet.items.map((i) => [i.action, i]));
    assert.equal(byAction.kill?.entity_name, "Dead UGC");
    assert.equal(byAction.cut?.entity_name, "Weak Retarget");
    assert.equal(byAction.scale?.entity_name, "Winner Balm");
    assert.match(byAction.scale?.say ?? "", /raise budget ~20%/);
    assert.match(byAction.scale?.say ?? "", /Do not move this onto Brand Search/);
    assert.equal(byAction.keep?.entity_name, "Steady Keep");
    assert.equal(byAction.refresh?.entity_name, "Hook A");
    assert.match(byAction.refresh?.say ?? "", /CTR collapsed/);
    assert.ok(sheet.items.length <= 6);
    assert.equal(sheet.items[0].rank, 1);
    assert.ok(sheet.items.every((i) => i.spend >= 1));
  });

  test("child ad set covers the parent campaign when it is most of the spend", () => {
    const campaigns = week("2026-09-21", {
      campaign_name: "UGC Balm", spend: 40, conv_value: 0, conversions: 0,
    });
    const adsets = weekGrain("2026-09-21", {
      grain: "adset", campaign_name: "UGC Balm", entity_name: "25-34 women",
      spend: 36, conv_value: 0, conversions: 0,
    });
    const sheet = buildMetaCallSheet({ campaigns, adsets, asOf: "2026-09-21" });
    assert.equal(sheet.items.length, 1);
    assert.equal(sheet.items[0].entity_kind, "adset");
    assert.equal(sheet.items[0].entity_name, "25-34 women");
    assert.match(sheet.items[0].say, /Pause 25-34 women ad set/);
  });

  test("Google rows never appear on the Meta call sheet", () => {
    const sheet = buildMetaCallSheet({
      campaigns: week("2026-09-21", {
        platform: "google",
        campaign_name: "Brand Search",
        spend: 80,
        conv_value: 0,
        conversions: 0,
        is_brand: true,
        campaign_type: "Search",
      }),
      asOf: "2026-09-21",
    });
    assert.equal(sheet.items.length, 0);
  });
});

describe("metaDigestActions", () => {
  test("locked-day pause lines skip unnamed / sub-$5 / missing conversions", () => {
    const rows = metaDigestActions([
      { metric_date: "2026-09-21", campaign_name: "Dead UGC", spend: 12, conversions: 0 },
      { metric_date: "2026-09-21", campaign_name: "Cheap", spend: 3, conversions: 0 },
      { metric_date: "2026-09-21", campaign_name: "Unknown", spend: 20 },
      { metric_date: "2026-09-20", campaign_name: "Yesterday", spend: 40, conversions: 0 },
    ], "2026-09-21");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].say, "Pause Dead UGC.");
    assert.equal(rows[0].spend, 12);
  });
});

describe("buildIntel attaches the Meta call sheet", () => {
  test("API grains produce a ranked list on the bundle", () => {
    const campaigns = week("2026-09-21", {
      campaign_name: "Dead UGC", spend: 22, conv_value: 0, conversions: 0,
    });
    const intel = buildIntel({
      campaigns,
      queries: [],
      ga: [],
      range: 7,
      filter: "meta",
      meta_detail: {
        adsets: [],
        ads: [],
        platforms: [],
        demos: [],
      },
    });
    assert.equal(intel.as_of, "2026-09-21");
    assert.ok(intel.meta_call_sheet);
    assert.equal(intel.meta_call_sheet?.items[0]?.action, "kill");
    assert.match(intel.grok.markdown, /Meta ads-manager call/);
    assert.match(intel.grok.adsDesk, /Pause Dead UGC/);
    assert.doesNotMatch(intel.grok.markdown, /upload a Google or Meta CSV/);
  });
});
