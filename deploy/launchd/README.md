# Mac Mini Autonomous Operation

The agent runs as a launchd **user agent**: it starts at login, restarts if it
crashes, and runs every scheduled sync itself. After the one-time install below,
routine PPC/sales refresh never needs a terminal.

## Install launchd agent

```bash
# Copy plist to LaunchAgents
cp deploy/launchd/com.tallowbourn.salestax.plist ~/Library/LaunchAgents/

# Load (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.tallowbourn.salestax.plist

# Verify running — prints "<PID> 0 com.tallowbourn.salestax"
launchctl list | grep tallowbourn
```

## Manage

```bash
# Restart after a code update (this is the one you'll use)
launchctl kickstart -k gui/$(id -u)/com.tallowbourn.salestax

# Stop
launchctl unload ~/Library/LaunchAgents/com.tallowbourn.salestax.plist

# View logs
tail -f logs/agent.out.log     # job output
tail -f logs/agent.err.log     # tracebacks

# What has actually run (no SQL needed)
python -m src.main jobs
python -m src.main jobs --failures
python -m src.main jobs --job ads_campaigns_sync
```

A code change does **not** take effect until the agent is restarted — the
scheduler builds its job list once at startup.

## What it runs

`python -m src.main run` starts the folder watcher plus APScheduler. All cron
times are **America/New_York** (`config/business_rules.json` → `agent.timezone`),
set explicitly on the scheduler so a change to the machine's own clock cannot
move them. Amazon *day boundaries* remain America/Los_Angeles — that is a
separate rule and is unaffected.

| Job | Schedule (ET) | What |
|-----|---------------|------|
| heartbeat | every 5 min | Stamp `logs/heartbeat.json` — liveness for the health check |
| ads_campaigns_sync | 05:00 daily | 30d campaign dailies, ≤30d chunks → KPIs + trends |
| ads_search_terms_sync | 05:30 daily | 7d search terms, 7d chunks, 90-min cap + retry |
| ads_actions | 06:00 daily | Rebuild the Actions queue (7d, 30% target ACOS) |
| spapi_refresh | 06:00 daily | SP-API orders + inventory + daily sales (TACOS denominator) |
| inventory_sync | 06:30 daily | FBA summaries + AWD + restock + velocity |
| cpa_exports | 06:30 daily | CPA export files to Supabase storage |
| 3pl_sync | 06:35 daily | Ship Sidekick inventory levels |
| daily_analysis | 08:00 daily | Physical + economic nexus evaluation |
| daily_digest | 08:05 daily | Telegram sales summary |
| health_ping | 08:10 daily | **One** Telegram check-in: ads scoreboard + freshness + faults |
| deadline_check | 09:00 daily | Filing deadline monitoring |
| shopify_poll | every few hours | Shopify orders → sales_by_state + sales_daily |
| ads_campaigns_backfill | Sun 03:00 | 90d campaigns (3 × 30d chunks) for long trends |
| source_monitoring | Mon 07:00 | Rule-source change detection |
| github_backup | Sun 09:00 | Backup branch push |

The three ads jobs are deliberately separate. Campaign reports are quick and
feed the /ppc KPI cards and trend chart; search-term reports are heavy and can
take up to 90 minutes. Splitting them means a search-term timeout can never
delay or cancel the campaign refresh — worst case you get current KPIs and
yesterday's Actions queue, recorded as `partial` rather than `fail`.

All jobs write to the `job_runs` table (`success` / `partial` / `fail` with
timestamps), which is what the dashboard's "last sync" label reads.

## Daily health check-in

One message a day, at 08:10 ET (`config/health.json` → `schedule`). It runs
after the 08:00 analysis and 08:05 digest so it reports on *this* morning's
jobs rather than yesterday's.

Healthy:

```
✅ Sales Tax Agent OK — 2026-08-21

Ads 7d to 2026-08-20 (LA closed days):
  $3,010 spend · $7,521 sales · ACOS 40.0% · ROAS 2.50x · TACoS 13.7%
  vs prior 7d: spend +7% · sales +0% · ACOS 37.3% → 40.0%
Last ads sync: 2026-08-21T14:56 (3h)
SQP: newest week 2026-08-15 (5d) · SQP history 33w
Playbook: 8 P0 open · scheduler: running (0m)
DB: ok
```

Degraded — same scoreboard, faults on top, no tracebacks:

```
🚨 Agent attention — 2026-08-21

- Ads sync stale — last success 31h ago (limit 26h)
- SQP newest week 2026-08-01 is 19d old (limit 10d)
- Scheduler heartbeat missing — is the agent running?
- Auth failure on ads_campaigns_sync — re-authorise
```

**Noise control.** At most one routine message per calendar day. A warning
repeats at most every 24h — but a NEW fault, or the same fault at higher
severity, sends immediately: a debounce window must never hide a situation
getting worse. State lives in `logs/health_state.json`; delete it to reset.

**Two liveness signals, detecting different failures.** The heartbeat file
catches a scheduler that is alive with wedged job threads. The *absence* of the
morning message catches a dead process — a dead scheduler cannot report on
itself. **Treat a missing 08:10 message as an alarm in its own right.**

Debug (never needed routinely):

```bash
python -m src.main health-ping --dry-run   # print message + send decision, deliver nothing
python -m src.main health-ping --send      # deliver, respecting the debounce
```

`--dry-run` works with `TELEGRAM_*` unset.

### Environment flags

| Flag | Default | Effect |
|------|---------|--------|
| `HEALTH_TELEGRAM` | `1` | `0` mutes delivery. The check still runs and still logs faults. |

Thresholds live in `config/health.json`: `ads_sync_stale_hours` 26 (not 24 — the
sync runs at 05:00, so 24 would flag every slightly-late run), `sqp_stale_days`
10 (SQP publishes ~7d in arrears), `ads_data_stale_days` 2, heartbeat
`stale_after_minutes` 20.

## What you never need to run weekly

Ads ingestion, actions rebuild, SQP sync and P&L are all scheduled above. The
PPC brief stays on demand — export it when you want to think, not on a timer.
There is deliberately **no** weekly brief pushed to Telegram; the daily check-in
is the only routine message. To make the dashboard's "Copy full AI brief" button
work without reaching this machine, publish a copy:

```bash
python -m src.main ppc-export --publish
```

## Prerequisites

- `.env` with all API keys (Supabase, SP-API, Shopify, Ship Sidekick, Telegram)
- Python venv at `.venv/` with dependencies installed
- Supabase migrations run (especially `migration_wave_a.sql` and
  `migration_ingestion_log_spapi.sql`)
