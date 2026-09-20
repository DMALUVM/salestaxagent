import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectorStatus } from "./phase2-env";

describe("phase2 env status never echoes secrets", () => {
  test("configured is false when names are blank", () => {
    const env: NodeJS.Dict<string> = {};
    const ga4 = connectorStatus("ga4", env);
    assert.equal(ga4.configured, false);
    assert.ok(ga4.missing.includes("GA4_PROPERTY_ID"));
    assert.deepEqual(ga4.scopes, ["https://www.googleapis.com/auth/analytics.readonly"]);
  });

  test("Meta scope is ads_read only", () => {
    assert.deepEqual(connectorStatus("meta_ads", {}).scopes, ["ads_read"]);
  });
});

describe("phase2-status wiring", () => {
  const root = process.cwd();
  const status = readFileSync(path.join(root, "src/app/api/phase2-status/route.ts"), "utf8");
  const docs = readFileSync(path.join(root, "..", "docs/oauth-phase2.md"), "utf8");
  const digest = readFileSync(path.join(root, "src/app/api/conversion-digest/route.ts"), "utf8");

  test("status is presence-only and does not echo secrets", () => {
    assert.match(status, /hasGatewayKey/);
    assert.match(status, /shopify-funnel\/jev-triage/);
    assert.doesNotMatch(status, /process\.env\.(GOOGLE_OAUTH_CLIENT_SECRET|META_ADS_ACCESS_TOKEN)/);
  });

  test("does not add a second digest or Jev route", () => {
    assert.match(digest, /buildConversionDigest/);
    assert.doesNotMatch(status, /\/api\/jev-funnel/);
    assert.match(docs, /\/api\/shopify-funnel\/jev-triage/);
    assert.doesNotMatch(docs, /ecommdashboard\.com\/api\/jev-funnel/);
    assert.match(docs, /Do not add a second Jev job on Mini/);
  });
});
