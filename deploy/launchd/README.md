# Mac Mini Autonomous Operation

**Hands-off: auto-update enabled.** After the one-time install below, the Mini
tracks `origin/main` and runs every scheduled sync itself. Merges to `main` do
not need a human `git pull` or `launchctl kickstart`.

The agent is a launchd **user agent**: it starts at login and restarts if it
exits (`KeepAlive`). Auto-update is one APScheduler job inside this same
process, not a second copy of `src.main run`, so it cannot compete with the
running agent. The 07:23 failure-only health check below is a separate
calendar LaunchAgent. It does not start the scheduler.

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
# Stop
launchctl unload ~/Library/LaunchAgents/com.tallowbourn.salestax.plist

# View logs
tail -f logs/agent.out.log     # job output
tail -f logs/agent.err.log     # tracebacks

# What has actually run (no SQL needed)
python -m src.main jobs
python -m src.main jobs --failures
python -m src.main jobs --job git_auto_update
python -m src.main git-auto-update --dry-run
```

### How auto-update restarts the agent

`git_auto_update` runs daily at **04:30 ET** (before ads sync at 05:00) and
once ~90s after startup. It only fast-forwards `origin/main`.

- Already at latest `main` → no-op, no restart.
- Successful pull that moved HEAD → the process **exits 0**. launchd
  `KeepAlive` starts a new `python -m src.main run` on the new checkout.
- Dirty working tree (tracked files) or a diverged history → **abort**, no
  reset, no stash. A `job_runs` row is written (`fail`) and Telegram is
  pinged so it does not sit unnoticed.

We do **not** call `launchctl kickstart` from inside the process. Killing
the running job that way races the `job_runs` write and the graceful
shutdown handler. KeepAlive is the restart path; it is already on in the
plist (`ThrottleInterval` 10s prevents a crash loop).

Manual kickstart is an **emergency fallback** only — KeepAlive off, a
stuck process, or you want to load new code *right now* without waiting
for 04:30 / the next startup pass:

```bash
launchctl kickstart -k gui/$(id -u)/com.tallowbourn.salestax
```

Safety rules (enforced in `src/maintenance/git_auto_update.py`):

- `git pull --ff-only --no-rebase --no-edit --no-autostash origin main` only
- Never push, never `reset --hard`, never `clean`, never delete `.env`
- Off `main`, rebase/merge in progress, or local commits not in
  `origin/main` → abort
- `GIT_AUTO_UPDATE=0` disables the job; `GIT_AUTO_UPDATE_RESTART=0`
  pulls but does not exit

A code change still does not take effect until the process is respawned —
the scheduler builds its job list once at startup. Auto-update is what
does that respawn.

## What it runs

`python -m src.main run` starts the folder watcher plus APScheduler. All cron
times are **America/New_York** (`config/business_rules.json` → `agent.timezone`),
set explicitly on the scheduler so a change to the machine's own clock cannot
move them. Amazon *day boundaries* remain America/Los_Angeles — that is a
separate rule and is unaffected.

| Job | Schedule (ET) | What |
|-----|---------------|------|
| heartbeat | every 5 min | Stamp `logs/heartbeat.json` — liveness for the health check |
| git_auto_update | 04:30 daily + 90s after start | ff-only `origin/main`; exit so KeepAlive loads new code |
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
| shopify_funnel_sync | 07:15 daily | ShopifyQL session funnel + abandoned checkouts → `/shopper` |
| ga4_sync | 07:20 daily | GA4 Data API sessions / landings → `ga4_*_daily` (scheduled only when Mini `.env` has `GOOGLE_OAUTH_*` + `GA4_PROPERTY_ID`; prior America/New_York day + 7d lookback; one shot, no poll) |
| gsc_sync | 07:25 daily | Search Console API query/page totals → `gsc_query_daily` / `gsc_page_daily` plus device/country/searchAppearance → `gsc_*_device_daily` / `gsc_dim_daily` and a tiny PDP URL Inspection allowlist → `gsc_url_inspection` (scheduled only when Mini `.env` has `GOOGLE_OAUTH_*` + `GSC_SITE_URL`; prior America/New_York day + 7d lookback; GSC final data lags ~2d; inspect errors log + continue) |
| google_ads_sync | 07:30 daily | Google Ads API campaign dailies → `google_ads_daily` (scheduled only when Mini `.env` has `GOOGLE_OAUTH_*` + `GOOGLE_ADS_DEVELOPER_TOKEN` + `GOOGLE_ADS_CUSTOMER_ID`; `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for MCC; prior America/New_York day + 7d lookback; searchStream one shot; never mutate) |
| meta_ads_sync | 07:35 daily | Meta Marketing API campaign / adset / ad dailies + publisher_platform and age×gender campaign breakdowns → `meta_ads_daily` / `meta_ads_adset_daily` / `meta_ads_ad_daily` / `meta_ads_platform_daily` / `meta_ads_demo_daily` (scheduled only when Mini `.env` has `META_APP_ID` + `META_APP_SECRET` + `META_ADS_ACCESS_TOKEN` + `META_ADS_ACCOUNT_ID`; prior America/New_York day + 7d lookback; catch-up `meta-ads-sync --days 90`; `GET /{act_…}/insights` one shot; ads_read only; Meta CSV retired) |
| ads_campaigns_backfill | Sun 03:00 | 90d campaigns (3 × 30d chunks) for long trends |
| source_monitoring | Mon 07:00 | Rule-source change detection |
| github_backup | Sun 09:00 | Backup branch push |
| soldscope_daily_rt | daily 06:15 | SoldScope Rank Tracker reuse-only GET of existing hero groups + phrases/v2 heatmap history → `soldscope_rank_snapshots` (never create groups/phrases). 06:15 keeps a gap after ads_search_terms 05:30 and before inventory_sync/cpa_exports 06:30 so ranks are ready by ~07:00 ET |
| soldscope_weekly_sync | Sun 10:30 | SoldScope hero history + ratings + capped SV + KR (RT reuse-only fallback; daily RT is the heatmap fill) |
| soldscope_competitor_kr_sync | Sun 10:45 | Competitor reverse-ASIN KR cache-first (searchType0 GET only if missing/stale; no create) |

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

## Failure-only health check (07:23 ET)

Wakes the ops assistant only when something is broken. A healthy run exits 0
with no webhook and no Telegram. This does not change the Telegram allow/deny
list, and it only reads `job_runs` and `ads_day_completeness`.

Checks:

1. Latest Vercel production deployment of project `dashboard` is `READY`.
   If `VERCEL_TOKEN` and `VERCEL_ACCESS_TOKEN` are both unset, the check is
   skipped and one line is written to the error log. That is not a failure.
2. If this checkout is behind `origin/main`, fast-forward with the same
   ff-only rules as `git_auto_update` (`restart=False`, so this process does
   not exit), then `launchctl kickstart -k` the sync agent
   (`com.tallowbourn.salestax` by default). If any `job_runs` row is
   `running`, the pull and the kickstart are both skipped and that skip
   is not reported. The checkout stays behind so the 04:30 auto-update
   can fast-forward and respawn. Already up to date, or a pull plus
   kickstart that both succeed, is silent. A dirty tree, a diverged
   history, a failed pull, or a kickstart that was sent and failed is
   reported.
3. Every scheduled job that writes `job_runs` must have its latest
   meaningful row as `success` or `partial`, and that row must fall inside
   the freshness window derived from the scheduler cron (misfire grace
   included). A `running` row is healthy until it is older than 3 hours
   for an ads job or 1 hour otherwise. A heartbeat on that row
   (`heartbeat_at`, or the same field inside `stats`) that is still inside
   the ads lease stale window keeps the run healthy past that limit.
   `skipped` rows and messages such as "another ads pull is running" are
   not failures. A real `fail` includes the `message` text (for example
   an expired Meta access token on `meta_ads_sync`).
4. `ads_day_completeness` for Amazon D-1 (`amazon_as_of`, yesterday in
   America/Los_Angeles) must be `CLEAR` once the deadline has passed.
   Default deadline is 07:15 America/New_York.

`launchd` `StartCalendarInterval` uses the Mac's system timezone. The Mini
must stay on **America/New_York** so this fires at 07:23 ET. 07:23 is
not a scheduled job minute (`ga4_sync` is 07:20, `gsc_sync` is 07:25).

### Env vars (repo `.env`, not the plist)

| Name | Required | Purpose |
|------|----------|---------|
| `GROKBOT_HEALTH_WEBHOOK_URL` | yes | POST target. Missing URL or key: one log line, exit 2, no POST |
| `GROKBOT_HEALTH_WEBHOOK_KEY` | yes | Secret sent on the webhook |
| `GROKBOT_HEALTH_WEBHOOK_HEADER` | no | Default `Authorization: Bearer <key>`. `<key>` is replaced with the key. A bare name sends the key as the value |
| `GROKBOT_ADS_CLEAR_DEADLINE` | no | `HH:MM` in America/New_York. Default `07:15` |
| `GROKBOT_SYNC_LAUNCHD_LABEL` | no | Sync agent label to kickstart. Default `com.tallowbourn.salestax` |
| `VERCEL_TOKEN` | no | Vercel API token. Also accepts `VERCEL_ACCESS_TOKEN`. Unset → skip |
| `VERCEL_ORG_ID` | no | Team id query param. `VERCEL_TEAM_ID` is the same |
| `VERCEL_PROJECT_ID` | no | Defaults to project name `dashboard` |

Webhook body:

```json
{"checked_at":"2026-09-25T11:20:00+00:00","failures":[{"check":"job:meta_ads_sync","detail":"fail: Meta access token expired"}]}
```

### Install on the Mini

One time, after this commit is on the checkout (the 04:30 auto-update will
fast-forward `main`; this plist is not loaded until you install it):

```bash
cd /Users/maloney_assistant/sales-tax-agent

# Add the webhook to .env (values stay on the Mini; do not commit them)
# GROKBOT_HEALTH_WEBHOOK_URL=https://example.invalid/hook
# GROKBOT_HEALTH_WEBHOOK_KEY=...

bash deploy/launchd/install-healthcheck.sh

# Confirm it is loaded — exit status 0, no PID until 07:23
launchctl list | grep tallowbourn.healthcheck

# Manual run. Healthy: prints nothing, exits 0. Broken: POSTs JSON, exits 1.
.venv/bin/python scripts/healthcheck_wake.py
echo "exit=$?"
```

Logs: `logs/healthcheck.out.log` (empty on success) and
`logs/healthcheck.err.log` (the Vercel-skip note, and failures).

Unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.tallowbourn.healthcheck.plist
```

## Prerequisites

- `.env` with all API keys (Supabase, SP-API, Shopify, Ship Sidekick, Telegram)
- Python venv at `.venv/` with dependencies installed
- Supabase migrations run (especially `migration_wave_a.sql` and
  `migration_ingestion_log_spapi.sql`)
