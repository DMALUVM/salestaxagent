# Dashboard environment variables (Vercel)

Set these in **Vercel → Project `dashboard` → Settings → Environment Variables**,
for the Production environment (and Preview if you use preview deploys).

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | browser + server | Project URL. `NEXT_PUBLIC_` means it ships to the client — that is expected and safe for the URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | browser | Anon key, RLS-scoped. Safe to expose. |
| `SUPABASE_URL` | optional | server routes | Falls back to `NEXT_PUBLIC_SUPABASE_URL`. |
| `SUPABASE_SERVICE_KEY` | recommended | server routes only | Service role. **Never** prefix this with `NEXT_PUBLIC_` — that would publish a key that bypasses RLS to every visitor. Without it, server routes fall back to the anon key and any table not readable under RLS returns empty. |
| `DASHBOARD_USER` | yes | middleware | Basic-auth user. |
| `DASHBOARD_PASSWORD` | yes | middleware | Basic-auth password. The whole dashboard 503s if this is unset. |
| `SOLDSCOPE_API_TOKEN` | Mini only | Python daily RT + weekly history jobs | **Do not set on Vercel.** Existing `/ppc`, `/ppc/gno`, and Amazon Ops columns read `soldscope_*` through `SUPABASE_SERVICE_KEY`. Put the token on the Mac Mini `.env` so `soldscope_daily_rt` and `soldscope_weekly_sync` can run. Never commit it. |
| `AI_GATEWAY_API_KEY` | Vercel only | `/api/conversion-digest` (on read) and `/api/shopify-funnel/jev-triage` (cron warmup) | **Do not set on Mini.** Optional Jev severity on the as_of Shopify leak. CoS/Dave add via Vercel → Project `dashboard` → Settings → Environment Variables / Secure Vault (Production + Preview). Never commit. Never paste into chat, repo, or Mini `.env`. Missing key → `hold_for_review` and no LLM. improvements still emit when locked-day Shopify/GA4/GSC/Ads rows are material. |
| `CRON_SECRET` | Vercel only | same route (cron GET) | Optional. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Middleware allows that bearer on `/api/shopify-funnel/jev-triage` only. Manual trigger still uses dashboard Basic Auth. Do not put this on Mini. |

`src/lib/supabase-server.ts` resolves server credentials as
`SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_KEY ?? NEXT_PUBLIC_SUPABASE_ANON_KEY`, and throws
`"Supabase not configured for server"` if either resolves empty. That error
surfaces in the card as a visible failure state, not a blank panel.

## Routes and what they need

| Route | Needs | Degrades to |
|---|---|---|
| `/api/shopify-customers` | Supabase server creds + `shopify_orders` table | Visible error card naming the migration/backfill |
| `/api/shopify-funnel` | Supabase server creds + `shopify_funnel_*` / `shopify_abandoned_checkouts` | Visible setup hint naming the migration + `shopify-funnel-sync` + scopes |
| `/api/shopify-funnel/jev-triage` | Supabase service role + Vercel `AI_GATEWAY_API_KEY` | Cron warmup. Same `ensureFunnelJevTriage` as the digest. Fail-closed `hold_for_review` when the key is missing; silent → no LLM |
| `/api/conversion-digest` | Supabase service role + `shopify_funnel_*`; Jev key on Vercel | Iris contract. Prior-day ET date-lock; HOLD/GAP if the day is missing — never substitutes. improvements are ranked as_of actions (Shopify leak + GA4/GSC/Ads when material; max 5). Jev hold does not blank evidence. Fail closed → `improvements: []` when no material locked-day rows. Phase 2 OAuth is **not** required to read. |
| `/api/phase2-status` | none (boolean env flags only) | `configured: true/false` + missing names. Never echoes secret values. See `docs/oauth-phase2.md`. |
| `/api/ppc` | Supabase server creds | Load-failure card |
| `/api/paid-ads` | Supabase server creds + `paid_ads_snapshots` / `paid_ads_campaigns_window` | Empty Google/Meta cards + optional migration hint |
| `/api/paid-ads/csv` | Supabase server creds (POST) | 400 if no recognisable Google/Meta/GSC/GA4 rows; upserts `paid_*_daily` |
| `/api/paid-ads/intel` | Supabase server creds + `paid_campaign_daily` / `paid_search_query_daily` / `paid_ga_daily` | Empty intel + upload prompt when warehouse is empty |
| `/api/paid-ads/decision` | Supabase server creds + `paid_intel_decisions` | 409 naming the migration if the table is missing |
| `/api/paid-ads/ingest` | Supabase server creds (POST, Basic Auth) | 400 on bad payload; upserts those two tables on their production uniques |
| `/api/data-freshness` | Supabase server creds | Layout strip hidden (fail-soft) |
| `/api/ppc-export`, `/api/ppc-playbook` | a Python venv **on the same machine** | JSON `{available:false}` — these cannot work on Vercel; `ppc-export` falls back to the stored `ppc_briefs` row |
| `/api/registration-plan` | Supabase server creds + warehouse tables (`nexus_status`, `sales_by_state`, `inventory_events`, `state_rules`) | JSON `{available:false}` with a warehouse hint — computed in-process, no Python venv |
| `/api/warehouse` | Supabase server creds + allowlisted table | 400 if table is not on the allowlist; paginated `select *` |
| `/api/calendar` | Supabase server creds (POST) | 400 on unknown action; writes `filing_calendar` + `last_filed_through` |
| `/api/registrations` | Supabase server creds (POST) | Updates `nexus_status` + `state_rules` (due day / notes) |
| `/api/entity-obligations` | Supabase server creds (GET + PATCH) | PATCH settles `compliance_obligations`; GET is unchanged |

## Verifying a deploy

```bash
vercel project ls                     # confirm the project and its production URL
curl -s -o /dev/null -w '%{http_code}\n' \
  -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://<prod-url>/api/shopify-customers
```

A `200` with `"available":true` means the deploy, the env and the database are
all healthy. Deploys are triggered by pushing to `main` (GitHub integration) —
the local `dashboard/` directory is not `vercel link`ed, so `vercel --prod`
would prompt for a project and is not the normal path.

## Security: anon key vs service role

**Critical:** After `supabase/migration_rls_lockdown.sql` is applied, the anon
key cannot read or write any public table (RLS enabled, no anon policies).
That is intentional.

- Browser clients may still use `NEXT_PUBLIC_SUPABASE_ANON_KEY` for Auth /
  Realtime scaffolding, but data access must go through Next.js API routes
  that use **`SUPABASE_SERVICE_KEY`**.
- Never put the service role key in a `NEXT_PUBLIC_*` variable.
- The old `"Service role full access" … USING (true)` policies were unsafe:
  they applied to anon too. The lockdown migration drops them. The Postgres
  `service_role` bypasses RLS without needing a policy.
- See root `SECURITY.md` for the apply checklist.

## Paid Ads (Shopify) ingest

`/paid-ads` is fed by **CSV uploads** (Google Ads Daily, Meta campaign
export, GSC Queries/Chart/Pages, GA4 Explore) into `paid_campaign_daily`,
`paid_search_query_daily`, and `paid_ga_daily`. POST `/api/paid-ads/csv`.
The older Ads Ops JSON path (`POST /api/paid-ads/ingest` →
`paid_ads_snapshots`) still works. Neither path scrapes Ads Manager.
See `dashboard/PAID_ADS.md`.

## Phase 2 official-API connectors

Iris conversion digest. **Official APIs only** — not the CSV intel
tables above. Dave sets these on Vercel the same way as
`AI_GATEWAY_API_KEY`. Dana mirrors the same `GOOGLE_*` names into Mini
`.env` from 1Password so `ga4-sync` / `gsc-sync` / `google-ads-sync`
can pull. Never chat-paste keys. Meta stays a stub until those tokens
exist (`docs/oauth-phase2.md`).

| Variable | Required to *read* digest | Used by |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | no | Mini `ga4-sync` / `gsc-sync` / `google-ads-sync` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | no | same |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | no | same |
| `GA4_PROPERTY_ID` | no | Mini `ga4-sync` |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | no | Mini `google-ads-sync` |
| `GOOGLE_ADS_CUSTOMER_ID` | no | Mini `google-ads-sync` (Tallowbourn client) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | no | Mini `google-ads-sync` (MCC, optional) |
| `GSC_SITE_URL` | no | Mini `gsc-sync` |
| `META_APP_ID` | no | `meta-ads-sync` (scaffold) |
| `META_APP_SECRET` | no | `meta-ads-sync` (scaffold) |
| `META_ADS_ACCESS_TOKEN` | no | `meta-ads-sync` (scaffold) |
| `META_ADS_ACCOUNT_ID` | no | `meta-ads-sync` (scaffold) |


