/**
 * Browser-side helpers for Export GNO pack.
 *
 * The build stays on a small text status stream (`.\n` heartbeats, then
 * READY or GNOERR). The zip is a second, short same-origin GET that the
 * browser downloads natively. fetch()+arrayBuffer() on the long build
 * stream is the path that threw "Failed to fetch" after the server had
 * already finished the file.
 *
 * A native download cannot report a browser-bar failure back into the
 * banner. GNOERR and HTTP errors still show next to the button. Once READY
 * arrives, the banner says the file is saving.
 */

export function filenameFromDisposition(header: string | null): string | null {
  const match = /filename="([^"]+)"/i.exec(header ?? "");
  const name = match?.[1]?.trim();
  return name || null;
}

export function responseLooksLikeZip(contentType: string, disposition: string | null): boolean {
  if (contentType.toLowerCase().includes("zip")) return true;
  const name = filenameFromDisposition(disposition);
  return !!name && name.toLowerCase().endsWith(".zip");
}

export function exportFailureMessage(status: number, contentType: string, body: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) {
    try {
      const parsed = JSON.parse(body) as { hint?: unknown; error?: unknown };
      const hint = typeof parsed.hint === "string" ? parsed.hint.trim() : "";
      const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
      if (hint) return hint;
      if (error) return error;
    } catch {
      /* fall through to the raw body */
    }
  }
  if (/FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE|PAYLOAD_TOO_LARGE/i.test(body)) {
    return `Export failed (${status}). The pack was too large for the server to send, so nothing was saved.`;
  }
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 180);
  if (snippet) return `Export failed (${status}). ${snippet}`;
  return `Export failed (${status}). No zip was saved.`;
}

export type ExportBodyResult =
  | { ok: true; zip: Uint8Array }
  | { ok: false; message: string };

/** Drop leading heartbeat bytes. The zip still starts with the PK local header. */
export function interpretExportBody(bytes: Uint8Array): ExportBodyResult {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  const body = start === 0 ? bytes : bytes.subarray(start);
  const isZip = body.length >= 4
    && body[0] === 0x50
    && body[1] === 0x4b
    && body[2] === 0x03
    && body[3] === 0x04;
  if (isZip) {
    if (body.length < 22) {
      return { ok: false, message: "Export failed. The server returned an empty file, so nothing was saved." };
    }
    return { ok: true, zip: body.slice() };
  }
  const text = new TextDecoder().decode(body).replace(/^\uFEFF/, "").trim();
  if (text.startsWith("GNOERR:")) {
    const message = text.slice("GNOERR:".length).trim();
    return {
      ok: false,
      message: message || "Export failed while building the pack. Nothing was saved.",
    };
  }
  if (!text) {
    return { ok: false, message: "Export ended before the zip was sent. Nothing was saved." };
  }
  return { ok: false, message: "Export did not return a zip. Nothing was saved." };
}

/**
 * fetch() throws before an HTTP status exists. Name the phase so a dropped
 * socket is not shown as the browser's bare "Failed to fetch".
 */
export function exportThrownMessage(
  error: unknown,
  phase: "headers" | "body",
  timedOut: boolean,
): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const aborted = name === "AbortError" || /AbortError/i.test(message);
  if (timedOut) {
    return phase === "body"
      ? "Export timed out while the pack was still building. Try again and leave this tab open until the zip saves."
      : "Export timed out waiting for the server. Try again and leave this tab open until the zip saves.";
  }
  if (aborted) {
    return "Export was cancelled. Try again and leave this tab open until the zip saves.";
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return phase === "body"
      ? "The browser lost the connection while the pack was still building. Try Export again and leave this tab open until the zip saves."
      : "The browser lost the connection before any response arrived. Try Export again.";
  }
  const trimmed = message.trim();
  if (trimmed) return trimmed;
  return "Export failed. Nothing was saved.";
}

/** Start a browser download. Keep the blob URL alive so a large zip is not cancelled. */
export function triggerZipDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const PACK_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PACK_FILENAME_RE = /^gno-pack-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/;

export function isPackToken(token: string): boolean {
  return PACK_TOKEN_RE.test(token);
}

export function safePackFilename(name: string | null | undefined): string {
  const trimmed = String(name ?? "").trim();
  return PACK_FILENAME_RE.test(trimmed) ? trimmed : "gno-pack.zip";
}

/** Same-origin GET that returns the finished zip. The token is unguessable. */
export function readyPackDownloadUrl(token: string, filename: string): string {
  const params = new URLSearchParams({
    pack: token,
    name: safePackFilename(filename),
  });
  return `/api/ppc/gno-export?${params.toString()}`;
}

export type ExportStatusResult =
  | { ok: true; token: string; filename: string }
  | { ok: false; message: string };

/**
 * Parse a status-stream buffer. Returns null while the terminal line is
 * still incomplete. Heartbeat lines are a single `.`.
 */
export function consumeExportStatusText(text: string): ExportStatusResult | null {
  const lines = text.split(/\r?\n/);
  const complete = lines.slice(0, -1);
  for (const line of complete) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ".") continue;
    if (trimmed.startsWith("GNOERR:")) {
      const message = trimmed.slice("GNOERR:".length).trim();
      return {
        ok: false,
        message: message || "Export failed while building the pack. Nothing was saved.",
      };
    }
    if (trimmed.startsWith("READY ")) {
      try {
        const parsed = JSON.parse(trimmed.slice("READY ".length)) as {
          token?: unknown;
          filename?: unknown;
        };
        const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
        const filename = typeof parsed.filename === "string" ? parsed.filename.trim() : "";
        if (isPackToken(token) && filename) {
          return { ok: true, token, filename: safePackFilename(filename) };
        }
      } catch {
        return { ok: false, message: "Export finished but the download link was unreadable. Nothing was saved." };
      }
      return { ok: false, message: "Export finished but the download link was unreadable. Nothing was saved." };
    }
    return { ok: false, message: "Export did not return a download link. Nothing was saved." };
  }
  return null;
}

/**
 * Read the status stream incrementally. A network error after a complete
 * READY or GNOERR line is not a failure — the bytes already arrived.
 */
export async function readExportStatusStream(
  body: ReadableStream<Uint8Array> | null,
): Promise<ExportStatusResult> {
  if (!body) {
    return { ok: false, message: "Export ended before the pack was ready. Nothing was saved." };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let handedOff = false;
  const accept = (parsed: ExportStatusResult): ExportStatusResult => {
    handedOff = true;
    reader.cancel().catch(() => { /* stream may already be closed or errored */ });
    return parsed;
  };
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        const parsed = consumeExportStatusText(text.endsWith("\n") ? text : `${text}\n`);
        if (parsed) return accept(parsed);
        throw err;
      }
      if (next.value) text += decoder.decode(next.value, { stream: !next.done });
      const parsed = consumeExportStatusText(text);
      if (parsed) return accept(parsed);
      if (next.done) break;
    }
  } finally {
    if (!handedOff) {
      try { reader.releaseLock(); } catch { /* reader already released */ }
    }
  }
  const tail = consumeExportStatusText(text.endsWith("\n") ? text : `${text}\n`);
  if (tail) return tail;
  return { ok: false, message: "Export ended before the pack was ready. Nothing was saved." };
}

export interface NativeDownloadNode {
  name: string;
  title: string;
  href: string;
  target: string;
  rel: string;
  style: { width: string; height: string; border: string; position: string };
  setAttribute(name: string, value: string): void;
  click(): void;
  remove(): void;
}

export interface NativeDownloadDom {
  createElement(tag: "iframe" | "a"): NativeDownloadNode;
  body: { appendChild(node: unknown): void };
}

/**
 * Hand the finished pack URL to the browser download stack.
 * The zip bytes are not read in page JS. A zero-size iframe keeps an
 * error response off the dashboard page.
 */
export function triggerNativeGetDownload(
  url: string,
  dom: NativeDownloadDom = document as unknown as NativeDownloadDom,
): void {
  const iframe = dom.createElement("iframe");
  iframe.name = "gno-export-download";
  iframe.title = "GNO pack download";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.position = "absolute";
  const a = dom.createElement("a");
  a.href = url;
  a.target = iframe.name;
  a.rel = "";
  dom.body.appendChild(iframe);
  dom.body.appendChild(a);
  a.click();
  a.remove();
}
