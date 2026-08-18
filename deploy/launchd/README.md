# Mac Mini Autonomous Operation

## Install launchd agent

```bash
# Copy plist to LaunchAgents
cp deploy/launchd/com.tallowbourn.salestaxagent.plist ~/Library/LaunchAgents/

# Load (starts immediately and on every login)
launchctl load ~/Library/LaunchAgents/com.tallowbourn.salestaxagent.plist

# Verify running
launchctl list | grep tallowbourn
```

## Manage

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.tallowbourn.salestaxagent.plist

# Restart (after code update)
launchctl unload ~/Library/LaunchAgents/com.tallowbourn.salestaxagent.plist
launchctl load ~/Library/LaunchAgents/com.tallowbourn.salestaxagent.plist

# View logs
tail -f logs/agent.out.log
tail -f logs/agent.err.log
```

## What it runs

The `scheduler` command starts APScheduler with these daily jobs:

| Job | Schedule | What |
|-----|----------|------|
| shopify_poll | Every few hours | Shopify orders → sales_by_state + sales_daily |
| spapi_refresh | 06:00 | SP-API orders + inventory + daily sales |
| inventory_sync | 06:30 | FBA summaries + AWD + restock + velocity |
| cpa_exports | 06:30 | CPA export files to Supabase storage |
| 3pl_sync | 06:35 | Ship Sidekick inventory levels |
| daily_analysis | 08:00 | Physical + economic nexus evaluation |
| daily_digest | 08:05 | Telegram sales summary |
| deadline_check | 09:00 | Filing deadline monitoring |

All jobs log to `job_runs` table for dashboard health monitoring.

## Prerequisites

- `.env` with all API keys (Supabase, SP-API, Shopify, Ship Sidekick, Telegram)
- Python venv at `.venv/` with dependencies installed
- Supabase migrations run (especially `migration_wave_a.sql`)
