/**
 * GNO Watch alert Done checkoff.
 *
 * Observe only — checking Done never pauses, negates, or writes to Amazon.
 * Keys persist in localStorage immediately; the API upserts gno_alert_acks
 * when that table exists.
 */

import type { GnoAlert } from "./gno-ppc-watch";

export const GNO_ALERT_DONE_STORAGE = "gno-watch-alert-done-v1";

export type GnoAlertRef = Pick<GnoAlert, "code" | "campaign_name" | "search_term">;

export function gnoAlertKey(a: GnoAlertRef): string {
  const camp = String(a.campaign_name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const term = String(a.search_term ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return `${a.code}\t${camp}\t${term}`;
}

export function loadLocalDoneKeys(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(GNO_ALERT_DONE_STORAGE);
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

export function saveLocalDoneKeys(keys: string[]): string[] {
  const uniq = [...new Set(keys.filter((k) => k.length > 0))];
  if (typeof window !== "undefined") {
    window.localStorage.setItem(GNO_ALERT_DONE_STORAGE, JSON.stringify(uniq));
  }
  return uniq;
}

export function toggleDoneKey(keys: string[], key: string, done: boolean): string[] {
  const set = new Set(keys);
  if (done) set.add(key);
  else set.delete(key);
  return saveLocalDoneKeys([...set]);
}

export function mergeDoneKeys(...lists: Array<string[] | undefined>): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const k of list ?? []) {
      if (k) set.add(k);
    }
  }
  return [...set];
}

export function isAlertDone(a: GnoAlertRef, doneKeys: Iterable<string>): boolean {
  const set = doneKeys instanceof Set ? doneKeys : new Set(doneKeys);
  return set.has(gnoAlertKey(a));
}

export function splitDoneAlerts<T extends GnoAlertRef>(
  alerts: T[],
  doneKeys: Iterable<string>,
): { open: T[]; done: T[] } {
  const set = doneKeys instanceof Set ? doneKeys : new Set(doneKeys);
  const open: T[] = [];
  const done: T[] = [];
  for (const a of alerts) {
    (set.has(gnoAlertKey(a)) ? done : open).push(a);
  }
  return { open, done };
}
