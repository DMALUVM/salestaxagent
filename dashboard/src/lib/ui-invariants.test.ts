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
    assert.match(model, /FIRST_WAVE_AWD_TARGET_CAP = 61_425/);
    assert.match(ship, /FBA cap vs on-hand/);
    assert.match(ship, /Marpac→Tulsa/);
    assert.match(model, /Marpac→Tulsa/);
    assert.match(ship, /mix TBD/);
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
    assert.match(cols, /fba_fulfillable/);
    assert.doesNotMatch(pallets, /owned_total/);
    assert.doesNotMatch(pallets, /ownedNetworkTotal/);
    assert.doesNotMatch(pallets, /inventory-owned-total/);
    assert.match(api, /keepAwdInventoryRows/);
    assert.doesNotMatch(api, /awd_on_hand\s*>\s*0/);
  });

  test("FBA column is fulfillable; AWD zero-row is not blanked", () => {
    const page = src("src/app/inventory/page.tsx");
    assert.match(page, /formatSkuQty\(r\.fba_fulfillable\)/);
    assert.match(page, /formatSkuQty\(r\.awd_on_hand\)/);
    assert.doesNotMatch(page, /fmt\(r\.fba_on_hand\)/);
    assert.doesNotMatch(page, /r\.awd_on_hand > 0 \? fmt/);
    assert.doesNotMatch(
      page,
      /fba_on_hand = fulfillable \+ reserved \+ researching \+ unfulfillable_qty[\s\S]*formatSkuQty\(r\.fba_on_hand\)/,
    );
  });
});
