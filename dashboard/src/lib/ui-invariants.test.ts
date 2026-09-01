import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("calendar action labels", () => {
  test("the two mark-complete controls are not both labeled Filed", () => {
    const page = src("src/app/calendar/page.tsx");
    assert.match(page, /Mark filed/);
    assert.match(page, /File with amount/);
    // The old pair of identical "Filed" buttons lived in this row.
    assert.doesNotMatch(
      page,
      />\s*Filed\s*</,
      "Quick-mark and dialog buttons must not share the label Filed",
    );
  });

  test("keeps late/overdue treatment from filings PR #2", () => {
    const page = src("src/app/calendar/page.tsx");
    assert.match(page, /agentToday\(\)/);
    assert.match(page, /f\.status === "late"/);
    assert.match(page, /Overdue \(\{overdue\.length\}\)/);
    // Tab stays mounted even when the count is 0.
    assert.doesNotMatch(page, /\{overdue\.length > 0 && \(\s*<TabsContent value="overdue"/);
    assert.match(page, /MonthGroupedFilings/);
  });
});

describe("entity review cards", () => {
  test("do not render raw enabled_obligations config keys", () => {
    const page = src("src/app/entity/page.tsx");
    assert.doesNotMatch(page, /enabled_obligations/);
  });
});

describe("3pl sign color", () => {
  test("negative ad-hoc amounts are not styled emerald/positive", () => {
    const page = src("src/app/inventory/3pl/page.tsx");
    assert.match(page, /signColor/);
    assert.match(page, /fmtMoney/);
    assert.doesNotMatch(page, /adhoc < 0 \? "text-emerald/);
    assert.doesNotMatch(page, /amount < 0 \? "text-emerald/);
  });
});

describe("pallet planner ship view", () => {
  test("pallets page keeps only the ship plan, not cover-chrome", () => {
    const page = src("src/app/inventory/pallets/page.tsx");
    const ship = src("src/components/inventory/HolidayShipPlan.tsx");
    const model = src("src/lib/pallet-planner-model.ts");
    const both = page + "\n" + ship;
    assert.match(page, /HolidayShipPlan/);
    assert.match(ship, /NEXT HOP/);
    assert.match(ship, /3PL→FBA/);
    assert.match(ship, /Tulsa hold/);
    assert.match(ship, /AWD high water/);
    assert.match(ship, /not the near-term manufacture\/buy/);
    assert.match(ship, /First-wave AWD/);
    assert.match(ship + "\n" + model, /61_425|61425|61,425/);
    assert.match(ship, /assorted \+ orange/);
    assert.match(ship, /end of September/);
    assert.doesNotMatch(ship, /aim end of August if Marpac can/);
    assert.doesNotMatch(ship, /Aim end of August if Marpac can/);
    assert.doesNotMatch(model, /aim end of August if Marpac can/);
    assert.match(model, /FIRST_WAVE_AWD_TARGET_CAP = 61_425/);
    assert.match(ship, /FBA cap vs on-hand/);
    assert.match(ship, /Marpac→Tulsa/);
    assert.match(model, /Marpac→Tulsa/);
    assert.doesNotMatch(ship, /mix TBD/);
    assert.match(ship, /in transit/);
    assert.match(ship + "\n" + model, /2026-08-31/);
    assert.match(page + "\n" + ship, /August 3PL→FBA 12,960/);
    assert.match(ship, /August · 3PL→FBA/);
    assert.doesNotMatch(ship, /3PL→Marpac/);
    assert.doesNotMatch(model, /3PL→Marpac/);
    assert.doesNotMatch(both, /FBA Cover Alerts/);
    assert.doesNotMatch(both, /FBA Cover Projection/);
    assert.doesNotMatch(both, /Cover Shortfall/);
    assert.doesNotMatch(both, /Pallet Breakdown/);
    assert.doesNotMatch(both, /Next Pallet to Order/);
    assert.doesNotMatch(both, /Nov–Jan sell-through/);
    assert.doesNotMatch(both, /Manufacture \(AWD\)/);
    assert.doesNotMatch(both, /Transfers to FBA/);
    assert.doesNotMatch(both, /Gap to Produce/);
  });

  test("inventory holiday view drops logistics / 90d / reorder chrome", () => {
    const page = src("src/app/inventory/page.tsx");
    assert.match(page, /HolidayShipPlan/);
    assert.doesNotMatch(page, /Today&apos;s logistics/);
    assert.doesNotMatch(page, /Rate & lead-time calibration/);
    assert.doesNotMatch(page, /FBA &lt;60d/);
    assert.doesNotMatch(page, /Portfolio Cover/);
    assert.doesNotMatch(page, /units to order/);
    assert.doesNotMatch(page, /weeks of cover/);
    assert.doesNotMatch(page, /target 90d cover/);
  });

  test("owned Total column lives on /inventory, not /inventory/pallets", () => {
    const page = src("src/app/inventory/page.tsx");
    const pallets = src("src/app/inventory/pallets/page.tsx");
    const cols = src("src/lib/inventory-sku-columns.ts");
    const api = src("src/app/api/inventory/route.ts");
    assert.match(page, /owned_total/);
    assert.match(page, /ownedNetworkTotalForSku/);
    assert.match(page, /resolveVisibleColumns/);
    assert.match(page, /visibleSkuTableColumns/);
    assert.match(cols, /ALWAYS_VISIBLE_COLUMN_KEYS/);
    assert.match(cols, /owned_total/);
    assert.match(cols, /total_amazon/);
    assert.match(cols, /fba_fulfillable/);
    assert.doesNotMatch(cols, /fba_reserved/);
    assert.doesNotMatch(cols, /fba_unfulfillable/);
    assert.doesNotMatch(cols, /label: "Reserved"/);
    assert.doesNotMatch(cols, /label: "Unfulfillable"/);
    assert.doesNotMatch(pallets, /owned_total/);
    assert.doesNotMatch(pallets, /total_amazon/);
    assert.doesNotMatch(pallets, /ownedNetworkTotal/);
    assert.doesNotMatch(pallets, /inventory-owned-total/);
    assert.doesNotMatch(pallets, /inventory-sc-on-hand/);
    assert.match(api, /keepAwdInventoryRows/);
    assert.doesNotMatch(api, /awd_on_hand\s*>\s*0/);
  });

  test("inventory SKU table hides secondary columns on phone only", () => {
    const page = src("src/app/inventory/page.tsx");
    const cols = src("src/lib/inventory-sku-columns.ts");
    const nav = src("src/components/nav.tsx");
    assert.match(page, /skuColumnPhoneClass/);
    assert.match(page, /skuColumnPhoneClass\(key\)/);
    assert.match(page, /overflow-x-auto/);
    assert.match(page, /resolveVisibleColumns\(saved\)/);
    assert.doesNotMatch(page, /card-layout|sku-card/);
    assert.match(cols, /PHONE_HIDDEN_SKU_COLUMN_KEYS/);
    assert.match(cols, /hidden md:table-cell/);
    const resolver = cols.slice(
      cols.indexOf("export function resolveVisibleColumns"),
      cols.indexOf("export function visibleSkuTableColumns"),
    );
    assert.doesNotMatch(resolver, /PHONE_HIDDEN|skuColumnPhoneClass|hidden md:table-cell/);
    const hidden = [
      "total_u_7",
      "total_u_30",
      "inventory_u_30",
      "measured_receive_days",
      "measured_replenish_days",
      "pipeline_dos",
      "amz_rec_qty",
      "our_reorder_qty",
      "stockout_date",
      "network_oos_date",
    ];
    for (const key of hidden) {
      assert.match(page, new RegExp(`skuColumnPhoneClass\\("${key}"\\)`));
    }
    const keep = [
      "sku",
      "fba_fulfillable",
      "awd_on_hand",
      "tpl_available",
      "inbound",
      "total_amazon",
      "owned_total",
      "dos",
      "flag",
    ];
    for (const key of keep) {
      assert.doesNotMatch(page, new RegExp(`skuColumnPhoneClass\\("${key}"\\)`));
    }
    const mobile = nav.slice(nav.indexOf("export function MobileHeader"));
    assert.match(mobile, /inline-flex h-10 w-10 items-center justify-center/);
  });

  test("FBA column is SC on-hand; Total Amazon is the only new column", () => {
    const page = src("src/app/inventory/page.tsx");
    assert.match(page, /formatSkuQty\(r\.fba_fulfillable\)/);
    assert.match(page, /formatSkuQty\(r\.total_amazon\)/);
    assert.match(page, /formatSkuQty\(r\.awd_on_hand\)/);
    assert.match(page, /<span className=\{awdCellToneClass\(r\.awd_tone\)\}>/);
    assert.doesNotMatch(page, /TableCell className=\{`text-right tabular-nums \$\{awdCellToneClass/);
    const awd = src("src/lib/inventory-awd-rows.ts");
    assert.match(awd, /return "text-sky-300"/);
    assert.doesNotMatch(awd, /return "text-zinc-200"/);
    assert.doesNotMatch(page, /key: "awd_inbound"/);
    assert.doesNotMatch(page, /label: "AWD inbound"/);
    assert.match(page, /owned\.fbaOnHand/);
    assert.doesNotMatch(page, /formatSkuQty\(r\.fba_reserved\)/);
    assert.doesNotMatch(page, /formatSkuQty\(r\.fba_unfulfillable\)/);
    assert.doesNotMatch(page, /visibleKeys.has\("fba_reserved"\)/);
    assert.doesNotMatch(page, /visibleKeys.has\("fba_unfulfillable"\)/);
    assert.doesNotMatch(page, /fmt\(r\.fba_on_hand\)/);
    assert.doesNotMatch(page, /r\.awd_on_hand > 0 \? fmt/);
    assert.doesNotMatch(
      page,
      /fba_on_hand = fulfillable \+ reserved \+ researching \+ unfulfillable_qty[\s\S]*formatSkuQty\(r\.fba_on_hand\)/,
    );
  });

  test("owned Total helper has no lip-family or named-SKU special case", () => {
    const owned = src("src/lib/inventory-owned-total.ts");
    const sc = src("src/lib/inventory-sc-on-hand.ts");
    assert.doesNotMatch(owned, /DDPE0003|LIP_BALM|lip family|lipOnly|lip_only/);
    assert.doesNotMatch(sc, /DDPE0003|LIP_BALM|lip family|lipOnly|lip_only/);
    assert.match(owned, /fbaOnHand/);
    assert.match(owned, /totalAmazon/);
    assert.doesNotMatch(owned, /fbaUnfulfillable/);
  });
});
