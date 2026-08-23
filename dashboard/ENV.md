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

`src/lib/supabase-server.ts` resolves server credentials as
`SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_KEY ?? NEXT_PUBLIC_SUPABASE_ANON_KEY`, and throws
`"Supabase not configured for server"` if either resolves empty. That error
surfaces in the card as a visible failure state, not a blank panel.

## Routes and what they need

| Route | Needs | Degrades to |
|---|---|---|
| `/api/shopify-customers` | Supabase server creds + `shopify_orders` table | Visible error card naming the migration/backfill |
| `/api/ppc` | Supabase server creds | Load-failure card |
| `/api/paid-ads` | Supabase server creds + `paid_ads_snapshots` / `paid_ads_campaigns_window` | Empty Google/Meta cards + optional migration hint |
| `/api/paid-ads/ingest` | Supabase server creds (POST, Basic Auth) | 400 on bad payload; upserts those two tables on their production uniques |
| `/api/data-freshness` | Supabase server creds | Layout strip hidden (fail-soft) |
| `/api/ppc-export`, `/api/ppc-playbook`, `/api/registration-plan` | a Python venv **on the same machine** | JSON `{available:false}` — these cannot work on Vercel; `ppc-export` falls back to the stored `ppc_briefs` row |

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

`/paid-ads` is fed by an Ads Ops **structured JSON payload**, not by scraping
Google or Meta Ads Manager. Production already has `paid_ads_snapshots` and
`paid_ads_campaigns_window` (first `google_ads` rows as of 2026-08-22). The
migration is `IF NOT EXISTS` / additive — do not drop or truncate those
tables. POST to `/api/paid-ads/ingest` with dashboard Basic Auth; Dashboard
Agent may upsert the same uniques in Supabase. Payload shape:
`dashboard/PAID_ADS.md`.


