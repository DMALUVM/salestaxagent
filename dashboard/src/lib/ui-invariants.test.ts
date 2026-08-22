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
