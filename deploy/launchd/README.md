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
| ads_campaigns_sync | 05:00 daily | 30d campaign dailies, ≤30d chunks → KPIs + trends |
| ads_search_terms_sync | 05:30 daily | 7d search terms, 7d chunks, 90-min cap + retry |
| ads_actions | 06:00 daily | Rebuild the Actions queue (7d, 30% target ACOS) |
| spapi_refresh | 06:00 daily | SP-API orders + inventory + daily sales (TACOS denominator) |
| inventory_sync | 06:30 daily | FBA summaries + AWD + restock + velocity |
| cpa_exports | 06:30 daily | CPA export files to Supabase storage |
| 3pl_sync | 06:35 daily | Ship Sidekick inventory levels |
| daily_analysis | 08:00 daily | Physical + economic nexus evaluation |
| daily_digest | 08:05 daily | Telegram sales summary |
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

## Prerequisites

- `.env` with all API keys (Supabase, SP-API, Shopify, Ship Sidekick, Telegram)
- Python venv at `.venv/` with dependencies installed
- Supabase migrations run (especially `migration_wave_a.sql` and
  `migration_ingestion_log_spapi.sql`)
