import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  exportFailureMessage,
  filenameFromDisposition,
  responseLooksLikeZip,
} from "./gno-export-download";
import { unzipStore, zipAttachmentResponse, zipStore } from "./zip-store";

const VERCEL_BODY_LIMIT = Math.floor(4.5 * 1024 * 1024);

describe("GNO export download", () => {
  test("parses the stamped zip filename", () => {
    assert.equal(
      filenameFromDisposition('attachment; filename="gno-pack-2026-09-24_1415.zip"'),
      "gno-pack-2026-09-24_1415.zip",
    );
    assert.equal(filenameFromDisposition(null), null);
  });

  test("treats application/zip and a .zip disposition as a download", () => {
    assert.equal(responseLooksLikeZip("application/zip", null), true);
    assert.equal(responseLooksLikeZip("application/octet-stream", 'attachment; filename="gno-pack.zip"'), true);
    assert.equal(responseLooksLikeZip("application/json", null), false);
    assert.equal(responseLooksLikeZip("text/plain", 'attachment; filename="error.txt"'), false);
  });

  test("surfaces JSON hints and the Vercel payload error instead of a silent miss", () => {
    assert.equal(
      exportFailureMessage(503, "application/json", JSON.stringify({
        error: "sqp_weekly: timeout",
        hint: "Export reads stored ads tables + Campaigns API snapshot. Nothing writes to Amazon.",
      })),
      "Export reads stored ads tables + Campaigns API snapshot. Nothing writes to Amazon.",
    );
    assert.match(
      exportFailureMessage(500, "text/plain", "FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE"),
      /too large/,
    );
    assert.match(exportFailureMessage(504, "text/plain", ""), /Export failed \(504\)/);
  });

  test("deflates a repetitive pack under the 4.5MB response cap and round-trips", () => {
    const line = "campaign,term,spend\nAuto Loose,tallow lip balm,1.23\n";
    const body = line.repeat(180_000);
    assert.ok(body.length > VERCEL_BODY_LIMIT);
    const zip = zipStore([
      { name: "negatives_snapshot.csv", body },
      { name: "README.txt", body: "Observe only. Never writes to Amazon.\n" },
    ]);
    assert.ok(zip.length < VERCEL_BODY_LIMIT, `zip ${zip.length} still over 4.5MB`);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    const files = unzipStore(zip);
    assert.equal(files.length, 2);
    assert.equal(files[0].name, "negatives_snapshot.csv");
    assert.equal(files[0].body, body);
    assert.match(files[1].body, /Observe only/);
  });

  test("attachment response is a zip stream with the pack filename", async () => {
    const zip = zipStore([{ name: "README.txt", body: "Observe only.\n" }]);
    const res = zipAttachmentResponse(zip, "gno-pack-2026-09-24_1415.zip", {
      "x-gno-observe-only": "1",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="gno-pack-2026-09-24_1415.zip"',
    );
    assert.equal(res.headers.get("content-length"), null);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(bytes, zip);
    assert.equal(unzipStore(bytes)[0].body, "Observe only.\n");
  });

  test("export route streams a deflated zip and does not buffer a Node Buffer", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    assert.match(route, /zipAttachmentResponse\(zip, pack\.filename/);
    assert.match(route, /maxDuration = 300/);
    assert.match(route, /application\/zip|zipAttachmentResponse/);
    assert.doesNotMatch(route, /Buffer\.from\(zip\)/);
    assert.match(route, /observe/i);
    assert.match(ui, /exportFailureMessage/);
    assert.match(ui, /triggerZipDownload/);
    assert.match(ui, /data-gno-notice/);
    assert.doesNotMatch(ui, /URL\.revokeObjectURL\(url\)/);
  });
});
