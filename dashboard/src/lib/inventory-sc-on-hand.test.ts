import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseReservedSplits,
  scOnHandUnits,
  scReservedUnits,
  totalAmazonUnits,
} from "./inventory-sc-on-hand";

describe("reserved splits from restock / planning raw", () => {
  test("reads FC transfer / processing / customer order from restock raw", () => {
    const splits = parseReservedSplits({
      "FC transfer": "553",
      "FC Processing": "1324",
      "Customer Order": "74",
    });
    assert.equal(splits.fcTransfer, 553);
    assert.equal(splits.fcProcessing, 1324);
    assert.equal(splits.customerOrder, 74);
    assert.equal(scOnHandUnits(3501, splits), 4054);
    assert.equal(scReservedUnits(1953, splits), 1398);
    assert.notEqual(scReservedUnits(1953, splits), 1953);
  });

  test("accepts planning hyphenated keys and Total Reserved Quantity", () => {
    const splits = parseReservedSplits(undefined, {
      "fc-transfer": "18",
      "Total Reserved Quantity": "67",
    });
    assert.equal(splits.fcTransfer, 18);
    assert.equal(splits.totalReservedSc, 67);
    assert.equal(scOnHandUnits(2507, splits), 2525);
    assert.equal(scReservedUnits(87, splits), 67);
  });

  test("parses JSON string raw payloads", () => {
    const splits = parseReservedSplits(
      JSON.stringify({ "FC transfer": 40, "FC Processing": 17, "Customer Order": 44 }),
    );
    assert.equal(splits.fcTransfer, 40);
    assert.equal(scReservedUnits(99, splits), 61);
  });

  test("without splits, reserved is API reserved minus FC transfer (0)", () => {
    const splits = parseReservedSplits(undefined, undefined);
    assert.equal(splits.fcTransfer, 0);
    assert.equal(scOnHandUnits(3501, splits), 3501);
    assert.equal(scReservedUnits(1953, splits), 1953);
  });
});

describe("double-count trap", () => {
  test("API fulfillable + reserved is not SC on-hand + reserved", () => {
    const splits = parseReservedSplits({
      "FC transfer": "553",
      "FC Processing": "1324",
      "Customer Order": "74",
    });
    const apiFulfillablePlusReserved = 3501 + 1953;
    const scOnHandPlusReserved = scOnHandUnits(3501, splits) + scReservedUnits(1953, splits);
    assert.equal(apiFulfillablePlusReserved, 5454);
    assert.equal(scOnHandPlusReserved, 4054 + 1398);
    assert.equal(scOnHandPlusReserved, 5452);
    assert.notEqual(
      totalAmazonUnits({
        fbaOnHand: 4054,
        inbound: 540,
        reservedSc: 1953,
        researching: 9,
      }),
      6001,
    );
  });
});
