# Phase 2 OAuth — Dave click checklists

Iris’s morning conversion email needs official-API warehouse numbers:
Shopify funnel (Phase 1, already live) **plus** GA4, Google Ads (site),
Meta, and Search Console. This is the in-house Ryze replacement.

**Rules**

- Official APIs only. No Ryze, no third-party analytics SaaS, no theme
  or storefront writes, no CSV substitute for these tables.
- Scopes are **min READ**. Do not grant write / manage / publish.
- Secrets land in **Vercel → Project `dashboard` → Settings →
  Environment Variables** (same place as `AI_GATEWAY_API_KEY`).
  When Dana wires Mini pulls, copy the **same names** into Mini `.env`
  from 1Password. **Never chat-paste keys.**
- Mini stubs (`ga4-sync`, `google-ads-sync`, `meta-ads-sync`, `gsc-sync`)
  exit `needs OAuth` and write **0 rows** until these exist. They never
  invent a metric.
- These tables never feed nexus, Pulse sales, or contribution P&L.

Apply `supabase/migration_conversion_phase2.sql` in the Supabase SQL
editor (RLS on, no anon policies) before expecting the digest route to
read the new tables.

---

## 1. GA4 Data API

**Where to create**

1. Google Cloud Console → the Tallowbourn project (or a new one Dave
   owns) → **APIs & Services → Enable APIs** → enable
   **Google Analytics Data API**.
2. **APIs & Services → Credentials → Create credentials → OAuth client
   ID** → Desktop app (Mini refresh) or Web app if the callback will
   live on the dashboard later. Download the client.
3. Google Analytics → Admin → Property access: the OAuth user must be
   Viewer (or Analyst) on the tallowbourn.com GA4 property. Copy the
   **Property ID** (`properties/XXXXXXXXX`).

**Scopes (READ only)**

- `https://www.googleapis.com/auth/analytics.readonly`

Do **not** add `analytics.edit` or `analytics.manage.users`.

**Where secrets land**

| Env name | Vercel | Mini `.env` |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | yes | yes, later (same name) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | yes, later |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | yes | yes, later |
| `GA4_PROPERTY_ID` | yes | yes, later |

`GOOGLE_OAUTH_*` is shared by GA4, Google Ads, and Search Console.
Create **one** Google OAuth client and one refresh token that has all
three READ scopes.

**What Dana verifies after**

- `python -m src.main ga4-sync` prints `needs OAuth` and writes 0 rows
  before the four env names exist.
- After env exists: stub still writes 0 rows until the Data API pull
  is wired. `ga4_sessions_daily` / `ga4_landing_daily` stay empty —
  never backfilled from `paid_ga_daily` or Shopify orders.
- `GET /api/conversion-digest?date=YYYY-MM-DD` keeps `landingDrops: null`
  until a real GA4 day lands. It does not show an older day’s landings.

---

## 2. Google Ads API

**Where to create**

1. Google Ads → **Admin → API Center** → apply for a **developer token**
   (test token is enough to start; production token needs Google review).
2. Same Google Cloud project → enable **Google Ads API**.
3. Same OAuth client as GA4. The Google account must be able to **view**
   the Tallowbourn Google Ads customer (not necessarily admin).
4. Copy the **customer ID** (`123-456-7890`, digits only in env). If the
   login is an MCC, also copy the login-customer ID.

**Scopes (min we will use)**

- `https://www.googleapis.com/auth/adwords`

Google does **not** ship a read-only Ads OAuth scope. Dave still grants
only a user who should not mutate, and Dana’s pull will **never** call
`mutate` / campaign write. Do not add extra Cloud scopes.

**Where secrets land**

| Env name | Vercel | Mini `.env` |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | yes (shared) | later |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (shared) | later |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | yes (shared) | later |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | yes | later |
| `GOOGLE_ADS_CUSTOMER_ID` | yes | later |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | optional MCC | later |

**What Dana verifies after**

- `python -m src.main google-ads-sync` → `needs OAuth`, 0 rows, no
  report wait-loop.
- After env: still 0 rows until the pull is wired. Do not copy
  `paid_campaign_daily` Google CSV rows into `google_ads_daily`.
- `google_ads_daily` is site Google Ads, **not** Amazon PPC
  (`ads_campaigns_daily`). Never join into contribution P&L.

---

## 3. Meta Marketing API

**Where to create**

1. [Meta for Developers](https://developers.facebook.com/) → the
   Tallowbourn Business app (or create one Dave owns).
2. Add the **Marketing API** product. App mode can stay In development
   while the ad account is owned by the same Business.
3. Business Settings → Users → the OAuth user needs **View performance**
   on the Tallowbourn ad account (not Manage campaigns).
4. Graph API Explorer (or a short OAuth dance) → long-lived user token
   with the scopes below. Copy the ad account id (`act_…`).

**Scopes (READ only)**

- `ads_read`
- `read_insights`

Do **not** grant `ads_management`, `business_management` (unless the
app already has it for something else — do not add it for this), or
page publish scopes.

**Where secrets land**

| Env name | Vercel | Mini `.env` |
|---|---|---|
| `META_APP_ID` | yes | later |
| `META_APP_SECRET` | yes | later |
| `META_ADS_ACCESS_TOKEN` | yes | later |
| `META_ADS_ACCOUNT_ID` | yes | later |

**What Dana verifies after**

- `python -m src.main meta-ads-sync` → `needs OAuth`, 0 rows.
- After env: 0 rows until the Insights pull is wired. Do not load
  Meta CSV uploads into `meta_ads_daily`.
- Token expiry: Dana rotates via 1Password → Vercel / Mini. Not Slack.

---

## 4. Search Console API

**Where to create**

1. Same Google Cloud project → enable **Google Search Console API**.
2. Search Console → the `tallowbourn.com` property (URL-prefix or
   `sc-domain:tallowbourn.com`) → Users → add the OAuth user as
   **Restricted** (site owner is fine; Restricted is the min).
3. Same Google OAuth client / refresh token as GA4, with the scope
   below added to the consent screen.

**Scopes (READ only)**

- `https://www.googleapis.com/auth/webmasters.readonly`

Do **not** add `webmasters` (write).

**Where secrets land**

| Env name | Vercel | Mini `.env` |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | yes (shared) | later |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (shared) | later |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | yes (shared) | later |
| `GSC_SITE_URL` | yes (`sc-domain:tallowbourn.com` or `https://tallowbourn.com/`) | later |

**What Dana verifies after**

- `python -m src.main gsc-sync` → `needs OAuth`, 0 rows.
- After env: 0 rows until the search-analytics pull is wired. Do not
  copy `paid_search_query_daily` CSV snapshots into `gsc_*_daily`.
- Digest `seo` stays `null` when the locked day has no GSC rows.
  Search Console lags ~2 days — that is a **null section**, not a
  reason to reuse Tuesday’s queries on Thursday. Iris date-lock.

---

## Shared Google OAuth (do this once)

Consent screen (External is fine for a single Dave user; Internal if
the Workspace is available):

1. App name: `Tallowbourn conversion digest`
2. Scopes, **only**:
   - `analytics.readonly`
   - `webmasters.readonly`
   - `adwords` (Ads — no read-only alternative; pull will not mutate)
3. Test user: Dave’s Google account
4. OAuth client → authorize once → store the **refresh token** in
   1Password → paste into Vercel `GOOGLE_OAUTH_REFRESH_TOKEN`

Redirect URI can wait. Scaffold stubs do not start a local server.

---

## Dashboard read path (no extra Google/Meta secrets)

`GET /api/conversion-digest?date=YYYY-MM-DD`

- Default `date` = prior day `America/New_York`.
- Iris date-lock: never substitute an older day into 1d numbers.
- Needs existing Vercel `SUPABASE_SERVICE_KEY` (already required).
- Does **not** need `GOOGLE_*` / `META_*` on Vercel until an OAuth
  callback is added. Warehouse reads only.

Status:

| Status | Meaning |
|---|---|
| `CLEAR` | Locked-day Shopify funnel row has sessions; Jev is not hold |
| `HOLD` | Locked-day row exists but sessions are null, or Jev/status is hold |
| `GAP` | No Shopify funnel row for the locked day |

Optional sections: `landingDrops` (GA4) and `seo` (GSC) are `null`
when that locked day is empty. `improvements` is `[]` until Jev
pursue items exist (max 3).

---

## CoS / Dave — after you click

1. Apply `supabase/migration_conversion_phase2.sql`.
2. Set the Vercel names in the table below (Production; Preview if
   you use it). Leave blank until the OAuth dance is done — blank is
   safer than a guessed token.
3. Do not put these on Slack, chat, or a PR comment.
4. Tell Dana which connectors are done. Mini pulls stay unscheduled
   until OAuth exists (a scheduled stub would fail every morning).
5. Shopify funnel (#149) and Jev Vercel wiring stay as they are.

### Vercel env names needed

```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
GA4_PROPERTY_ID
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CUSTOMER_ID
GOOGLE_ADS_LOGIN_CUSTOMER_ID   # optional MCC
GSC_SITE_URL
META_APP_ID
META_APP_SECRET
META_ADS_ACCESS_TOKEN
META_ADS_ACCOUNT_ID
```

Already required (unchanged): `SUPABASE_SERVICE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD`.
Jev stays on `AI_GATEWAY_API_KEY` (Vercel only — Mini is not given
that key in chat).
