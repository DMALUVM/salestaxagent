import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { firstLastFromReplenishments, openInboundSplit, splitLegDays } from "./split-leadtime";

const augSplit = {
  order_status: "SUCCESS",
  shipped_at: "2026-08-06T18:43:05Z",
  created_at: "2026-08-06T18:34:40Z",
  raw: {
    outboundShipments: [
      { shipmentStatus: "DELIVERED", updatedAt: "2026-08-10T20:19:59Z" },
      { shipmentStatus: "DELIVERED", updatedAt: "2026-08-13T07:18:51Z" },
      { shipmentStatus: "DELIVERED", updatedAt: "2026-08-14T11:19:56Z" },
      { shipmentStatus: "DELIVERED", updatedAt: "2026-08-23T17:34:30Z" },
    ],
  },
};

describe("split first vs last box", () => {
  test("Aug 4-box split is 4d first and 17d last", () => {
    const days = splitLegDays(augSplit);
    assert.equal(Math.min(...days), 4);
    assert.equal(Math.max(...days), 17);
  });

  test("median across splits", () => {
    const fast = {
      order_status: "SUCCESS",
      shipped_at: "2026-06-18T10:33:58Z",
      raw: {
        outboundShipments: [
          { shipmentStatus: "DELIVERED", updatedAt: "2026-06-19T13:48:35Z" },
          { shipmentStatus: "DELIVERED", updatedAt: "2026-06-20T06:00:21Z" },
        ],
      },
    };
    const out = firstLastFromReplenishments([augSplit, fast]);
    assert.equal(out.split_n, 2);
    assert.equal(out.first_box_days, 3);
    assert.equal(out.last_box_days, 10);
    assert.equal(out.box_spread_days, 7);
  });

  test("open inbound split picks the newest multi-FC send", () => {
    const open = openInboundSplit(
      [
        { shipment_status: "IN_TRANSIT", shipped_at: "2026-08-25T17:50:03Z", destination_fc: "VGT2" },
        { shipment_status: "IN_TRANSIT", shipped_at: "2026-08-25T17:50:03Z", destination_fc: "MCI4" },
        { shipment_status: "IN_TRANSIT", shipped_at: "2026-08-25T17:50:03Z", destination_fc: "MQY2" },
      ],
      new Date(2026, 7, 26),
    );
    assert.ok(open);
    assert.equal(open?.boxes, 3);
    assert.deepEqual(open?.fcs, ["MCI4", "MQY2", "VGT2"]);
  });
});
