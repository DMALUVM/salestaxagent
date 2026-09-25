# AGENTS.md

Guidance for AI agents working in this repo (Tallowbourn ops dashboard: Next.js app in `dashboard/`, Python sync jobs, Supabase warehouse).

## Code Review Rules

Flag only P0/P1 issues. Treat these as blocking:

1. **Supabase access stays server-side.** Never expose the Supabase service-role key (or any secret) to the browser, a `NEXT_PUBLIC_*` variable, logs, or client bundles. Pages must read warehouse data through server-side / service-role API routes; do not move pages back to browser `anon` Supabase queries, and do not disable or weaken RLS on public tables.
2. **Telegram alerts keep the PR #144 allow/deny list.** Allowed: sales-tax overdue/filing risk, threshold crossed, health faults, job failures, inventory damaged/unfillable, inventory checked in, Monday paid-ads freshness. Denied: routine health/all-good, ads scoreboard, playbook P0 counts, GNO export due, source monitor. Any change that adds a new alert type or unmutes a denied one needs an explicit reason in the PR.
3. **Sales-tax math needs a test.** Any change to tax rates, nexus thresholds, taxable-sales totals, filing amounts, or state attribution must add or update a test that covers the changed calculation.
