import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  exportFailureMessage,
  exportThrownMessage,
  filenameFromDisposition,
  interpretExportBody,
  responseLooksLikeZip,
} from "./gno-export-download";
import { streamingZipResponse, unzipStore, zipAttachmentResponse, zipStore } from "./zip-store";

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

  test("export route writes a heartbeat before the pack build and does not buffer a Node Buffer", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const handler = route.slice(route.indexOf("export function GET"));
    assert.match(handler, /streamingZipResponse\(/);
    assert.doesNotMatch(handler, /await /);
    assert.match(route, /maxDuration = 300/);
    assert.doesNotMatch(route, /zipAttachmentResponse/);
    assert.doesNotMatch(route, /Buffer\.from\(zip\)/);
    assert.match(route, /observe/i);
    assert.match(ui, /exportFailureMessage/);
    assert.match(ui, /exportThrownMessage/);
    assert.match(ui, /interpretExportBody/);
    assert.match(ui, /triggerZipDownload/);
    assert.match(ui, /data-gno-notice/);
    assert.match(ui, /data-gno-notice-tone=\{noticeTone\}/);
    assert.match(ui, /showNotice\(exportFailureMessage\(res\.status, ct, text\), "err"\)/);
    assert.match(ui, /showNotice\(\s*"Pack is building on the server/);
    assert.doesNotMatch(ui, /URL\.revokeObjectURL\(url\)/);
    assert.match(ui, /exportThrownMessage\(e, phase, timedOut\)/);
  });

  test("heartbeats arrive before the zip exists, then strip back to a real zip", async () => {
    const zip = zipStore([{ name: "README.txt", body: "Observe only.\n" }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let built = false;
    const res = streamingZipResponse("gno-pack-2026-09-24_1415.zip", async () => {
      await gate;
      built = true;
      return zip;
    }, {
      heartbeatMs: 20,
      extraHeaders: { "x-gno-observe-only": "1" },
    });
    assert.equal(res.headers.get("x-gno-zip-framing"), "nul-heartbeat");
    assert.equal(res.headers.get("x-gno-observe-only"), "1");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(built, false);
    assert.equal(first.value?.[0], 0);
    release();
    const parts: Uint8Array[] = [];
    if (first.value) parts.push(first.value);
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) parts.push(next.value);
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const part of parts) {
      all.set(part, off);
      off += part.length;
    }
    const parsed = interpretExportBody(all);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.zip, zip);
    assert.equal(unzipStore(parsed.zip)[0].body, "Observe only.\n");
  });

  test("a build failure is a GNOERR payload, not a rejected stream", async () => {
    const res = streamingZipResponse("gno-pack.zip", async () => {
      throw new Error("ads_search_terms_daily: fetch failed");
    }, { heartbeatMs: 5 });
    const parsed = interpretExportBody(new Uint8Array(await res.arrayBuffer()));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /ads_search_terms_daily: fetch failed/);
  });

  test("names timeout, dropped connection, and cancel instead of Failed to fetch", () => {
    assert.match(
      exportThrownMessage(new TypeError("Failed to fetch"), "headers", false),
      /lost the connection before any response arrived/,
    );
    assert.match(
      exportThrownMessage(new TypeError("Failed to fetch"), "body", false),
      /lost the connection while the pack was still building/,
    );
    assert.match(
      exportThrownMessage(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }), "body", true),
      /timed out while the pack was still building/,
    );
    assert.match(
      exportThrownMessage(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }), "headers", false),
      /cancelled/,
    );
    assert.doesNotMatch(
      exportThrownMessage(new TypeError("Failed to fetch"), "headers", false),
      /^Failed to fetch$/,
    );
  });
});
