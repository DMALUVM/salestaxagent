# Phase 2 — Dave click checklists + Iris pipeline

Hand this to Dave. One Google OAuth dance covers GA4 + Google Ads + Search Console. Meta is a separate Business app. Dave pastes secrets **only** on Vercel project `dashboard`. Dana mirrors the same `GOOGLE_*` names into Mini `.env` from 1Password so `ga4-sync` / `gsc-sync` / `google-ads-sync` can run. Never chat-paste keys.

Production site: `https://www.ecommdashboard.com`
Vercel env page: `https://vercel.com/dave-maloneys-projects/dashboard/settings/environment-variables`

---

## Daily pipeline (Iris) — one path, Jev is not an orphan

1. **Mini** `python -m src.main shopify-funnel-sync` writes `shopify_funnel_*` + abandons (already scheduled 07:15 ET).
2. **Mini** `ga4-sync` (07:20 ET), `gsc-sync` (07:25 ET), and `google-ads-sync` (07:30 ET) pull the official GA4 Data API / Search Console API / Google Ads API for the prior `America/New_York` day (7d lookback). Scheduled only when Mini `.env` has the same `GOOGLE_*` names as Vercel. `metric_date` is the API day — never an older substitute. GSC final data lags ~2 days → `phase2.seo` stays null until that locked day exists. Do not add poll agents. Meta stays a stub.
3. **Vercel** `GET`/`POST /api/shopify-funnel/jev-triage` (landed #153, sibling `bc-74a886b6`) evaluates leaks with `AI_GATEWAY_API_KEY` already on Vercel and writes `shopify_funnel_status.last_stats.jev`. Fail closed → `hold_for_review` / empty pursue. Does **not** call Mini.
4. **Iris** `GET /api/conversion-digest` (landed #154/#155) reads the prior-day `America/New_York` Shopify funnel snapshot and runs landed Jev. Missing day → GAP. Never substitutes an older day. `improvements` are ranked as_of actions (Shopify leak + GA4/GSC/Ads when material). `phase2.landing_drops` / `seo` / `ads` stay **null** until official-API rows exist for that day. OAuth is **not** required to read the Iris fields.

Do not add a second Jev job on Mini. Do not add a second digest or `/api/jev-funnel` route.

---

## Vercel env names (paste here, Production)

Open [Environment Variables](https://vercel.com/dave-maloneys-projects/dashboard/settings/environment-variables). Environment: **Production**. Key → Value → **Save**. Do not tick “Sensitive” unless you want the value hidden from Dana; the name still works either way.

```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
GA4_PROPERTY_ID
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CUSTOMER_ID
GOOGLE_ADS_LOGIN_CUSTOMER_ID   # only if you sign in through an MCC
GSC_SITE_URL
META_APP_ID
META_APP_SECRET
META_ADS_ACCESS_TOKEN
META_ADS_ACCOUNT_ID
```

Already there (do not recreate): `AI_GATEWAY_API_KEY`, `SUPABASE_SERVICE_KEY`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD`.

---

## 0. Shared Google OAuth (do this once)

Covers GA4 + Google Ads + Search Console. Use Dave’s Google account (the one that already owns tallowbourn.com / Analytics / Ads / Search Console).

### 0.1 Create or pick a Cloud project

1. Open https://console.cloud.google.com/welcome
2. Top bar project picker → **NEW PROJECT**
3. Project name: `tallowbourn-conversion`
4. **CREATE** → wait → picker → select `tallowbourn-conversion`

If you already have a Tallowbourn Cloud project, pick that instead. Do not create a second one.

### 0.2 Enable the three APIs

1. Open https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com → **ENABLE** (label: **Google Analytics Data API**)
2. Open https://console.cloud.google.com/apis/library/googleads.googleapis.com → **ENABLE** (label: **Google Ads API**)
3. Open https://console.cloud.google.com/apis/library/searchconsole.googleapis.com → **ENABLE** (label: **Google Search Console API**)

Done when each page shows **API enabled** / **Manage**.

### 0.3 Google Auth Platform — Branding

2026 console uses **Google Auth Platform**, not the old “OAuth consent screen” left-nav item.

1. Open https://console.cloud.google.com/auth/branding
2. If prompted **Get started** → click it
3. App name: `Tallowbourn conversion digest`
4. User support email: Dave’s Gmail
5. Audience: **External**
6. Developer contact: Dave’s Gmail
7. **CREATE** / **SAVE**

### 0.4 Audience — add Dave as test user

1. Open https://console.cloud.google.com/auth/audience
2. Publishing status stays **Testing** (do not click Publish app)
3. **+ ADD USERS** under Test users
4. Add Dave’s Google address
5. **SAVE**

### 0.5 Data Access — READ scopes only

1. Open https://console.cloud.google.com/auth/scopes
2. **ADD OR REMOVE SCOPES**
3. Filter / tick **only** these three (exact strings):
   - `https://www.googleapis.com/auth/analytics.readonly`
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/adwords`
4. **UPDATE** → **SAVE**

`adwords` is Google’s only Ads API scope. It is not read-only. Dana’s pull will never call mutate. Do not add `analytics.edit` or `webmasters` (write).

### 0.6 Clients — Web client (secret shown once)

1. Open https://console.cloud.google.com/auth/clients
2. **CREATE CLIENT**
3. Application type: **Web application**
4. Name: `tallowbourn-conversion-web`
5. Authorized redirect URIs → **ADD URI**:
   `https://developers.google.com/oauthplayground`
6. **CREATE**
7. Dialog **OAuth client created**:
   - Copy **Client ID** → Vercel `GOOGLE_OAUTH_CLIENT_ID`
   - Copy **Client secret** (`GOCSPX-…`) **now** → Vercel `GOOGLE_OAUTH_CLIENT_SECRET`
8. Close the dialog. The full secret is **not shown again** (hashed after create). If you lose it: open the client → **Add secret** / rotate.

### 0.7 Refresh token (OAuth Playground)

1. Open https://developers.google.com/oauthplayground
2. Gear (top right) → tick **Use your own OAuth credentials**
3. OAuth Client ID / Secret = the two Vercel values from 0.6
4. Close the gear
5. Left list → paste / tick the same three scopes from 0.5
6. **Authorize APIs**
7. Pick Dave’s Google account → if “Google hasn’t verified this app” → **Continue** (test user)
8. Allow the three READ scopes
9. **Exchange authorization code for tokens**
10. Copy **Refresh token** → Vercel `GOOGLE_OAUTH_REFRESH_TOKEN`

You’re done with Google identity when those three `GOOGLE_OAUTH_*` names are saved on Vercel.

**Common mistakes:** wrong Cloud project selected in the top picker; Published the app instead of leaving Testing; forgot Dave as test user (`access_denied`); redirect URI not exactly the Playground URL (`redirect_uri_mismatch`); closed the client-secret dialog without copying.

---

## 1. GA4 Data API

**Pick this property:** the GA4 property that receives tallowbourn.com (not a GA4 360 demo, not an old UA view).

1. Open https://analytics.google.com/analytics/web/
2. Bottom-left **Admin** (gear)
3. Confirm the **Account** / **Property** pair is Tallowbourn / tallowbourn.com
4. Property column → **Property details**
5. Copy **Property ID** (digits only, e.g. `123456789`)
6. Vercel → `GA4_PROPERTY_ID` = those digits (Dana can prefix `properties/` later)

**Access (if the OAuth Google user is not already Admin):**

1. Admin → **Property access management**
2. **+** → add Dave’s Google as **Viewer**
3. Do not grant Editor

**Dana verify after**

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://www.ecommdashboard.com/api/phase2-status
```

Success: `connectors.ga4.configured` is `true` and `missing` is `[]`.

Then:

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  "https://www.ecommdashboard.com/api/conversion-digest"
```

Success: HTTP 200, `"as_of"` is prior-day ET, status `CLEAR`/`HOLD`/`GAP`. `"phase2": { "landing_drops": null, … }` until a locked-day `ga4_landing_daily` row exists. Never an older day’s landings.

Mini needs the same names in `.env` (Dana mirrors from 1Password — never chat-paste):

```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
GA4_PROPERTY_ID=411710093
```

Then `python -m src.main ga4-sync` pulls `runReport` and upserts `ga4_sessions_daily` / `ga4_landing_daily`. Missing Mini env → `needs OAuth` / `Wrote 0 rows` (fail closed). `--dry-run` documents the path and does not upsert.

**You’re done when:** Property ID is on Vercel, Mini `.env` has the same `GOOGLE_*` names, and `/api/phase2-status` shows GA4 configured.

**Fail modes:** copied a **Measurement ID** (`G-XXXX`) instead of Property ID; picked the wrong property in the Admin header; Data API not enabled on this Cloud project; `analytics.edit` added (remove it).

---

## 2. Google Ads API

**Pick this account:** the **Tallowbourn client** ad account that spends on tallowbourn.com. Not Amazon PPC. If the top-right account chip is a **manager** (MCC), click it and switch into the Tallowbourn client before copying IDs.

1. Open https://ads.google.com/aw/overview
2. Top-right account chip → note the **10-digit ID**
3. Vercel `GOOGLE_ADS_CUSTOMER_ID` = those 10 digits, **no dashes** (`123-456-7890` → `1234567890`)
4. If you only reach that client through an MCC: copy the **MCC** 10-digit ID → Vercel `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. Skip this name if you sign in directly to the client.

**Developer token (2026):**

- If you **already** have a token: switch the account chip to the **MCC** → open https://ads.google.com/aw/apicenter → **API Access** / **Developer token** → copy the 22-character token → Vercel `GOOGLE_ADS_DEVELOPER_TOKEN`. Explorer / Test access is enough to start.
- If you **do not** have a token: do **not** apply on the old API Center (new signups there are sunset). Stay in Cloud project `tallowbourn-conversion` → https://console.cloud.google.com/apis/api/googleads.googleapis.com/overview → use **Google Ads API Overview** to request access. Paste the token onto Vercel when Google shows it.

The OAuth user must be able to **view** the Tallowbourn client (standard user is enough). Do not make the OAuth user an admin just for this.

**Dana verify after**

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://www.ecommdashboard.com/api/phase2-status
```

Success: `connectors.google_ads.configured` is `true`.

Mini `.env` also needs the Ads names (plus the shared `GOOGLE_OAUTH_*`):

```
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CUSTOMER_ID=5332206723
GOOGLE_ADS_LOGIN_CUSTOMER_ID=7137868835
```

Then `python -m src.main google-ads-sync` pulls `googleAds:searchStream` and upserts `google_ads_daily`. Missing Mini env → `needs OAuth` / `Wrote 0 rows` (fail closed). `--dry-run` documents the path and does not upsert. Read-only despite `adwords` scope — never mutate.

**You’re done when:** customer ID + developer token + shared `GOOGLE_OAUTH_*` are on Vercel, Mini `.env` has the same names, and a pull upserts the locked day (or 0 rows if the API returned none).

**Fail modes:** pasted the MCC id into `GOOGLE_ADS_CUSTOMER_ID` (that reads the manager, not Tallowbourn); left the dashes in the id; applied on API Center after the 2026 sunset; added mutate / campaign-write tooling (we never will).

---

## 3. Meta Marketing API

**Pick this account:** the Tallowbourn Business + the ad account that exported as `Tallow-ourn-Ad-Account-…` (Ads Manager URL contains `act=`). Not a personal “just me” ad account if the Business one is the live spender.

### 3.1 App

1. Open https://developers.facebook.com/apps/
2. **Create app**
3. Use case: **Other** → type **Business**
4. App name: `Tallowbourn conversion digest`
5. Business portfolio: Tallowbourn
6. **Create app**
7. App Dashboard left nav → **Use cases** → add **Measure ad performance** if it is not already there
8. Permissions: **`ads_read` only**. Do **not** add `ads_management` (that can spend). Do **not** add `read_insights` (that is Page insights, not ads).
9. Settings → **Basic**: copy **App ID** → Vercel `META_APP_ID`; **App secret** → Show → Vercel `META_APP_SECRET`
10. Leave the app **In development**. Standard `ads_read` is enough for an ad account you own.

### 3.2 System user token (no 60-day expiry)

1. Open https://business.facebook.com/settings/system-users
2. Confirm the top-left Business is Tallowbourn
3. **Add** → name `conversion-digest` → role **Employee**
4. Open that system user → **Assign assets** → **Ad accounts** → the Tallowbourn ad account → permission **View performance** (or Analyst). Not Manage campaigns.
5. **Generate token** → pick app `Tallowbourn conversion digest` → permission **`ads_read`** → generate
6. Copy token **now** → Vercel `META_ADS_ACCESS_TOKEN`

### 3.3 Ad account id

1. Open https://adsmanager.facebook.com/adsmanager/manage/campaigns
2. Confirm the account name is Tallowbourn (not a random personal account)
3. Look at the URL: `act=1234567890` → Vercel `META_ADS_ACCOUNT_ID` = `act_1234567890`

**Dana verify after**

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://www.ecommdashboard.com/api/phase2-status
```

Success: `connectors.meta_ads.configured` is `true`.

**You’re done when:** all four `META_*` names are on Vercel and the system user can see the Tallowbourn ad account.

**Fail modes:** granted `ads_management`; token from Graph API Explorer (expires ~60 days) instead of a system user; copied the App ID into `META_ADS_ACCOUNT_ID`; assigned the system user to the wrong ad account; app in a different Business than the ad account.

---

## 4. Search Console API

**Pick this property:** the Search Console property for tallowbourn.com. Prefer the **Domain** property `tallowbourn.com` (covers www + bare + http). If you only have a URL-prefix property, use that.

1. Open https://search.google.com/search-console
2. Top-left property picker → `tallowbourn.com` (Domain) or `https://tallowbourn.com/`
3. Vercel `GSC_SITE_URL`:
   - Domain property → `sc-domain:tallowbourn.com`
   - URL-prefix → `https://tallowbourn.com/` (trailing slash required)

**Access:** Settings (left, gear) → **Users and permissions**. Dave’s Google (the OAuth user) must already be **Owner** or **Restricted**. Restricted is the minimum. Do not add a new write-capable owner.

The Search Console API was enabled in 0.2. The refresh token from 0.7 already includes `webmasters.readonly`.

**Dana verify after**

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://www.ecommdashboard.com/api/phase2-status
```

Success: `connectors.gsc.configured` is `true`.

Then conversion-digest `"seo": null` until a locked-day GSC row exists. GSC lags ~2 days — that is a **null section**, not a reason to reuse Tuesday’s queries.

Mini `.env` also needs `GSC_SITE_URL=sc-domain:tallowbourn.com` (plus the shared `GOOGLE_OAUTH_*` names). Then `python -m src.main gsc-sync` pulls `searchAnalytics.query` and upserts `gsc_query_daily` / `gsc_page_daily`. Missing Mini env → `needs OAuth` / 0 rows.

**You’re done when:** `GSC_SITE_URL` matches the property type (domain vs URL-prefix), Mini has the same names, and phase2-status shows GSC configured.

**Fail modes:** `https://www.tallowbourn.com/` when the property is the domain; missing `sc-domain:` prefix; missing trailing slash on a URL-prefix property; added `webmasters` write scope.

---

## Jev (Vercel only)

`AI_GATEWAY_API_KEY` is already on Vercel. Do not put it on Mini. Do not chat-paste it.

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  -X POST https://www.ecommdashboard.com/api/shopify-funnel/jev-triage
```

Success: HTTP 200. Missing key → `"decision": "hold"` / `hold_for_review` and no LLM. Silent last_stats → no LLM. A non-empty `pursue` list with invented copy is a bug.

```bash
curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  "https://www.ecommdashboard.com/api/conversion-digest"
```

Success: HTTP 200, `"as_of"` is prior-day ET, `"improvements"` empty or at most 5 ranked as_of actions (named path / query / campaign). Never invent copy. Never use an older day’s numbers.

**You’re done when:** POST `/api/shopify-funnel/jev-triage` and GET `/api/conversion-digest` both return 200 without inventing copy.

---

## Apply the empty warehouse (Dana, once)

In Supabase SQL editor run `supabase/migration_conversion_phase2.sql`. RLS on, no anon policies. Tables start empty. They never feed nexus or P&L.

---

## CoS — you’re done when

1. Phase 2 migration is applied.
2. `/api/phase2-status` shows the connectors Dave finished as `configured: true` (blank connectors stay `false` — that is safer than a guessed token).
3. `/api/conversion-digest` returns prior-day ET `as_of` (GAP if that day is missing — never substitutes).
4. `/api/shopify-funnel/jev-triage` is the only Jev evaluate (Vercel). Fail closed when the gateway key is missing.
5. `/api/shopify-funnel` still works (Phase 1). No Mini Jev job. No `/api/jev-funnel`.
