/**
 * Phase 2 official-API env names. Secrets live on Vercel project
 * `dashboard` (same page as AI_GATEWAY_API_KEY). Never echo values.
 */
export const PHASE2_CONNECTORS = {
  ga4: {
    label: "GA4 Data API",
    env: [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
      "GA4_PROPERTY_ID",
    ],
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  },
  google_ads: {
    label: "Google Ads API",
    env: [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_CUSTOMER_ID",
    ],
    optional: ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
    scopes: ["https://www.googleapis.com/auth/adwords"],
  },
  meta_ads: {
    label: "Meta Marketing API",
    env: [
      "META_APP_ID",
      "META_APP_SECRET",
      "META_ADS_ACCESS_TOKEN",
      "META_ADS_ACCOUNT_ID",
    ],
    scopes: ["ads_read"],
  },
  gsc: {
    label: "Search Console API",
    env: [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
      "GSC_SITE_URL",
    ],
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  },
} as const;

export type Phase2Connector = keyof typeof PHASE2_CONNECTORS;

export function missingEnv(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return keys.filter((k) => !String(env[k] ?? "").trim());
}

export function connectorStatus(
  name: Phase2Connector,
  env: NodeJS.ProcessEnv = process.env,
) {
  const spec = PHASE2_CONNECTORS[name];
  const missing = missingEnv(spec.env, env);
  return {
    label: spec.label,
    configured: missing.length === 0,
    missing,
    scopes: [...spec.scopes],
  };
}
