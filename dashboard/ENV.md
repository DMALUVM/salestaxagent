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
