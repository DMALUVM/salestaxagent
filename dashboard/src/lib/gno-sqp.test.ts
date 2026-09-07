import test from "node:test";
import assert from "node:assert/strict";
import { parseSqpCsv } from "./gno-sqp";

test("SQP parser uses rank when present", () => {
  const csv = "Search Query,ASIN,Organic Rank\ntallow lip balm,B0CLHVCPL5,2\n";
  const r = parseSqpCsv(csv, "", "2026-09-01");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].organic_rank, 2);
  assert.equal(r.rows[0].keyword_normalized, "tallow lip balm");
});

test("SQP parser derives a band from click share and never invents a share", () => {
  const csv = "Search Query,Click Share\nchapstick,55%\nunknown,\n";
  const r = parseSqpCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].organic_rank, 1);
  assert.equal(r.skipped, 1);
});

test("empty / no-query file does not fake numbers", () => {
  const r = parseSqpCsv("Impressions,Purchases\n10,2\n");
  assert.equal(r.rows.length, 0);
  assert.ok(r.warnings[0]?.includes("no search-query"));
});
