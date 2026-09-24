import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { zipStore, unzipStore } from "./zip-store";
import {
  loadPack,
  packObjectPath,
  recallPack,
  storePack,
  type PackBlobStore,
} from "./gno-export-handoff";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

function memoryStore(): PackBlobStore & { paths: Map<string, Uint8Array> } {
  const paths = new Map<string, Uint8Array>();
  return {
    paths,
    async upload(path, body) {
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      paths.set(path, copy);
    },
    async download(path) {
      return paths.get(path) ?? null;
    },
  };
}

describe("GNO export handoff", () => {
  test("rejects a token that is not a uuid", () => {
    assert.throws(() => packObjectPath("../etc/passwd"), /bad pack token/);
    assert.equal(recallPack("../etc/passwd"), null);
  });

  test("stores a real zip and reads it back without the build stream", async () => {
    const zip = zipStore([{ name: "README.txt", body: "Observe only.\n" }]);
    const store = memoryStore();
    await storePack(TOKEN, zip, store);
    assert.equal(store.paths.size, 1);
    assert.equal([...store.paths.keys()][0], `packs/${TOKEN}.zip`);
    const loaded = await loadPack(TOKEN, {
      async upload() { throw new Error("download path should not upload"); },
      async download() { return null; },
    });
    assert.ok(loaded);
    assert.deepEqual(loaded, zip);
    assert.equal(unzipStore(loaded!)[0].body, "Observe only.\n");
  });

  test("another instance loads the stored bytes when memory missed", async () => {
    const token = "323e4567-e89b-42d3-a456-426614174000";
    const zip = zipStore([{ name: "README.txt", body: "Observe only.\n" }]);
    const store = memoryStore();
    await store.upload(packObjectPath(token), zip);
    assert.equal(recallPack(token), null);
    const loaded = await loadPack(token, store);
    assert.ok(loaded);
    assert.deepEqual(loaded, zip);
    assert.equal(recallPack(token), null);
  });
});
