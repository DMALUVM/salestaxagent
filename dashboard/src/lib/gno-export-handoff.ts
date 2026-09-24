/**
 * Short-lived handoff for a finished GNO pack zip.
 * The build request only streams status text. The browser then GETs the
 * zip from a different invocation, so the bytes live in Supabase Storage
 * (and in memory on the instance that built them). Observe only — this
 * does not write to Amazon Ads.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPackToken } from "./gno-export-download";
import { getServerSupabase } from "./supabase-server";

export const GNO_PACK_BUCKET = "gno-packs";
const MEMORY_TTL_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 60 * 60 * 1000;

interface MemoryPack {
  zip: Uint8Array;
  at: number;
}

const memory = new Map<string, MemoryPack>();
let bucketReady = false;

export function packObjectPath(token: string): string {
  if (!isPackToken(token)) throw new Error("bad pack token");
  return `packs/${token}.zip`;
}

export function rememberPack(token: string, zip: Uint8Array): void {
  if (!isPackToken(token)) throw new Error("bad pack token");
  const copy = new Uint8Array(zip.byteLength);
  copy.set(zip);
  memory.set(token, { zip: copy, at: Date.now() });
}

export function recallPack(token: string): Uint8Array | null {
  if (!isPackToken(token)) return null;
  const hit = memory.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMORY_TTL_MS) {
    memory.delete(token);
    return null;
  }
  return hit.zip;
}

export interface PackBlobStore {
  upload(path: string, body: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array | null>;
}

export async function storePack(
  token: string,
  zip: Uint8Array,
  store: PackBlobStore = supabasePackStore(),
): Promise<void> {
  const copy = new Uint8Array(zip.byteLength);
  copy.set(zip);
  await store.upload(packObjectPath(token), copy);
  rememberPack(token, copy);
}

export async function loadPack(
  token: string,
  store?: PackBlobStore,
): Promise<Uint8Array | null> {
  const cached = recallPack(token);
  if (cached) return cached;
  if (!isPackToken(token)) return null;
  const blobStore = store ?? supabasePackStore();
  return blobStore.download(packObjectPath(token));
}

function supabasePackStore(): PackBlobStore {
  return {
    async upload(path, body) {
      const sb = getServerSupabase();
      await ensureGnoPackBucket(sb);
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      const { error } = await sb.storage.from(GNO_PACK_BUCKET).upload(path, copy, {
        contentType: "application/zip",
        upsert: false,
        cacheControl: "0",
      });
      if (error) throw new Error(error.message);
      void pruneOldPacks(sb);
    },
    async download(path) {
      const sb = getServerSupabase();
      const { data, error } = await sb.storage.from(GNO_PACK_BUCKET).download(path);
      if (error) {
        const code = `${error.statusCode ?? ""}`;
        if (code === "404" || /not found|does not exist/i.test(error.message)) return null;
        throw new Error(error.message);
      }
      if (!data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

async function ensureGnoPackBucket(sb: SupabaseClient): Promise<void> {
  if (bucketReady) return;
  const { error } = await sb.storage.createBucket(GNO_PACK_BUCKET, { public: false });
  if (error && !/exist|duplicate|409/i.test(`${error.message} ${error.statusCode ?? ""}`)) {
    throw new Error(error.message);
  }
  bucketReady = true;
}

async function pruneOldPacks(sb: SupabaseClient): Promise<void> {
  try {
    const { data, error } = await sb.storage.from(GNO_PACK_BUCKET).list("packs", { limit: 100 });
    if (error || !data?.length) return;
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const stale = data
      .filter((obj) => {
        const t = Date.parse(obj.created_at ?? obj.updated_at ?? "");
        return Number.isFinite(t) && t < cutoff;
      })
      .map((obj) => `packs/${obj.name}`);
    if (stale.length) await sb.storage.from(GNO_PACK_BUCKET).remove(stale);
  } catch {
    /* leftover objects expire by the next export's prune */
  }
}
