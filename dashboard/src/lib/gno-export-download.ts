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
