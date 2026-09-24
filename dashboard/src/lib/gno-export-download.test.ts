import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  consumeExportStatusText,
  exportFailureMessage,
  exportThrownMessage,
  filenameFromDisposition,
  interpretExportBody,
  isPackToken,
  readExportStatusStream,
  readyPackDownloadUrl,
  responseLooksLikeZip,
  safePackFilename,
  triggerNativeGetDownload,
  type NativeDownloadNode,
} from "./gno-export-download";
import {
  BUFFERED_ZIP_MAX,
  readyZipResponse,
  streamingExportStatus,
  streamingZipResponse,
  unzipStore,
  zipAttachmentResponse,
  zipStore,
} from "./zip-store";

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

  test("export route returns a status stream, then a short native zip GET", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const handler = route.slice(route.indexOf("export function GET"));
    assert.match(handler, /streamingExportStatus\(/);
    assert.doesNotMatch(handler, /await /);
    assert.match(handler, /searchParams\.get\("pack"\)/);
    assert.match(route, /maxDuration = 300/);
    assert.match(route, /storePack\(/);
    assert.match(route, /readyZipResponse\(/);
    assert.doesNotMatch(route, /streamingZipResponse/);
    assert.doesNotMatch(route, /Buffer\.from\(zip\)/);
    assert.match(route, /observe/i);
    assert.match(ui, /exportFailureMessage/);
    assert.match(ui, /exportThrownMessage/);
    assert.match(ui, /readExportStatusStream/);
    assert.match(ui, /triggerNativeGetDownload/);
    assert.match(ui, /readyPackDownloadUrl/);
    assert.doesNotMatch(ui, /arrayBuffer\(/);
    assert.doesNotMatch(ui, /interpretExportBody/);
    assert.match(ui, /data-gno-notice/);
    assert.match(ui, /data-gno-notice-tone=\{noticeTone\}/);
    assert.match(ui, /showNotice\(exportFailureMessage\(res\.status, ct, text\), "err"\)/);
    assert.match(ui, /Export GNO pack/);
    assert.match(ui, /Check your Downloads folder\. Observe only/);
    assert.match(ui, /showNotice\(\s*"Pack is building on the server/);
    const helper = readFileSync(path.join(process.cwd(), "src/lib/gno-export-download.ts"), "utf8");
    assert.match(helper, /empty file, so nothing was saved/);
    assert.doesNotMatch(ui, /Failed to fetch/);
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

  test("status text ignores heartbeats and reads READY or GNOERR", () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const filename = "gno-pack-2026-09-24_1227.zip";
    assert.equal(consumeExportStatusText(".\n"), null);
    assert.equal(consumeExportStatusText(`.\nREADY ${JSON.stringify({ token, filename })}`), null);
    const ready = consumeExportStatusText(`.\nREADY ${JSON.stringify({ token, filename })}\n`);
    assert.deepEqual(ready, { ok: true, token, filename });
    const err = consumeExportStatusText(".\nGNOERR:ads_search_terms_daily: fetch failed\n");
    assert.equal(err?.ok, false);
    if (err?.ok !== false) return;
    assert.match(err.message, /ads_search_terms_daily/);
    assert.equal(isPackToken("../etc/passwd"), false);
    assert.equal(safePackFilename("../../evil.zip"), "gno-pack.zip");
    assert.equal(
      readyPackDownloadUrl(token, filename),
      `/api/ppc/gno-export?pack=${token}&name=${filename}`,
    );
  });

  test("a body error after READY still returns the download link", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const filename = "gno-pack-2026-09-24_1227.zip";
    const enc = new TextEncoder();
    const readyLine = `READY ${JSON.stringify({ token, filename })}`;
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        n += 1;
        if (n === 1) {
          controller.enqueue(enc.encode(".\n"));
          return;
        }
        if (n === 2) {
          controller.enqueue(enc.encode(readyLine));
          return;
        }
        controller.error(new TypeError("Failed to fetch"));
      },
    });
    const parsed = await readExportStatusStream(stream);
    assert.deepEqual(parsed, { ok: true, token, filename });
  });

  test("a body error before READY still rejects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("Failed to fetch"));
      },
    });
    await assert.rejects(
      () => readExportStatusStream(stream),
      (err: unknown) => err instanceof TypeError && /Failed to fetch/.test(err.message),
    );
  });

  test("status stream heartbeats before the pack is stored, then READY", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const filename = "gno-pack-2026-09-24_1415.zip";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let built = false;
    const res = streamingExportStatus(filename, async () => {
      await gate;
      built = true;
      return { token, filename };
    }, { heartbeatMs: 20, extraHeaders: { "x-gno-observe-only": "1" } });
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("x-gno-export-framing"), "status-line");
    assert.equal(res.headers.get("content-disposition"), null);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(built, false);
    assert.equal(new TextDecoder().decode(first.value), ".\n");
    release();
    const dec = new TextDecoder();
    let text = ".\n";
    while (true) {
      const next = await reader.read();
      if (next.value) text += dec.decode(next.value);
      if (next.done) break;
    }
    const parsed = consumeExportStatusText(text.endsWith("\n") ? text : `${text}\n`);
    assert.equal(parsed?.ok, true);
    if (!parsed?.ok) return;
    assert.equal(parsed.token, token);
    assert.equal(parsed.filename, filename);
  });

  test("a build failure is a GNOERR line on the status stream", async () => {
    const res = streamingExportStatus("gno-pack.zip", async () => {
      throw new Error("ads_search_terms_daily: fetch failed");
    }, { heartbeatMs: 5 });
    const parsed = await readExportStatusStream(res.body);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /ads_search_terms_daily: fetch failed/);
  });

  test("a short ready zip is the raw file with Content-Length and no heartbeat prefix", async () => {
    const zip = zipStore([{ name: "README.txt", body: "Observe only.\n" }]);
    const res = readyZipResponse(zip, "gno-pack-2026-09-24_1415.zip", {
      "x-gno-observe-only": "1",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(res.headers.get("content-length"), String(zip.byteLength));
    assert.equal(res.headers.get("x-gno-zip-framing"), null);
    assert.equal(res.headers.get("x-gno-observe-only"), "1");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.deepEqual(bytes, zip);
    assert.equal(unzipStore(bytes)[0].body, "Observe only.\n");
  });

  test("a pack over the buffered cap still streams a clean zip", async () => {
    const big = new Uint8Array(BUFFERED_ZIP_MAX + 1);
    big[0] = 0x50;
    big[1] = 0x4b;
    big[2] = 0x03;
    big[3] = 0x04;
    const res = readyZipResponse(big, "gno-pack-2026-09-24_1415.zip");
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="gno-pack-2026-09-24_1415.zip"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.byteLength, big.byteLength);
    assert.equal(bytes[0], 0x50);
    assert.notEqual(bytes[0], 0);
  });

  test("native download targets a hidden iframe, not fetch", () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const filename = "gno-pack-2026-09-24_1227.zip";
    const url = readyPackDownloadUrl(token, filename);
    const appended: string[] = [];
    let clicked = "";
    const dom = {
      body: { appendChild(node: unknown) { appended.push((node as { href?: string; name?: string }).href || (node as { name?: string }).name || ""); } },
      createElement(tag: "iframe" | "a"): NativeDownloadNode {
        const node: NativeDownloadNode = {
          name: "",
          title: "",
          href: "",
          target: "",
          rel: "",
          style: { width: "", height: "", border: "", position: "" },
          setAttribute() { /* aria */ },
          click() { clicked = node.href; },
          remove() { /* detached */ },
        };
        node.name = tag;
        return node;
      },
    };
    triggerNativeGetDownload(url, dom);
    assert.equal(clicked, url);
    assert.ok(appended.includes("gno-export-download"));
    assert.ok(appended.includes(url));
  });
});
