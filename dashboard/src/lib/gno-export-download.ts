/**
 * Browser-side helpers for Export GNO pack.
 * The click handler waits on a long pack build, then must still save a zip
 * and must show a visible error when the response is not a zip.
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
