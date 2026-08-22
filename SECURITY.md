# Security notes

## Supabase keys

- **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** is safe to expose to the browser **only if
  Row Level Security (RLS) is enabled and deny-by-default** on every public
  table. With the old `"Service role full access" … USING (true)` policies,
  the anon key could read/write everything — treat that as a breach until
  `supabase/migration_rls_lockdown.sql` has been applied in production.
- **`SUPABASE_SERVICE_KEY`** (service role) bypasses RLS. It must live only in
  server-side env (Vercel / Mac Mini agent). Never prefix it with
  `NEXT_PUBLIC_`. Dashboard API routes that mutate or read sensitive tables
  require the service role; falling back to the anon key after lockdown will
  correctly return empty/denied results.

See also `dashboard/ENV.md`.

## Applying the RLS lockdown

1. Review `supabase/migration_rls_lockdown.sql`.
2. Run it in the Supabase SQL editor (production) when ready — do **not**
   flip RLS from an automated agent without a human check.
3. Confirm dashboard server routes still use `SUPABASE_SERVICE_KEY`.
4. Smoke-test: anon client should see no rows; service role still works.

## Generated exports

CPA packets, filing CSVs, and similar artifacts under `exports/` are gitignored.
Regenerate them on the Mac Mini / via `agent_jobs`; do not commit them.
