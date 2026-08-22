# Multi-State Sales Tax Compliance Agent

**Amazon FBA + Shopify | Monitoring, Flagging & Alerting System**

> **What this system does**: Aggregates sales and inventory data from Amazon FBA and Shopify, detects physical and economic nexus across US states, tracks filing deadlines, and sends proactive alerts via Telegram and email.
>
> **What this system does NOT do**: It does not file tax returns, remit payments, calculate tax rates on individual transactions, or replace a CPA. Every recommendation includes confidence notes and requires human confirmation. State tax rules change frequently and some positions are actively litigated — always verify flags with a qualified tax professional before acting.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Data You Need to Gather (Do This First)](#data-you-need-to-gather)
4. [Setup Instructions](#setup-instructions)
5. [Running the System](#running-the-system)
5b. [FBA Inventory Feed (Physical Nexus)](#fba-inventory-feed-physical-nexus)
6. [Intelligence Layer](#intelligence-layer)
7. [Dashboard](#dashboard)
8. [Weekly / Monthly Maintenance Rhythm](#maintenance-rhythm)
9. [Configuration Reference](#configuration-reference)
10. [Limitations & Disclaimers](#limitations--disclaimers)
11. [Future Phases](#future-phases)

---

## Architecture Overview

```
Mac Mini (always-on)
├── Python agent (scheduler, parsers, engines, alerts)
├── Amazon SP-API integration (automatic orders + inventory refresh)
├── Shopify API polling (every 4h)
├── Folder watcher: ~/sales-tax-agent/incoming/ (CSV fallback)
├── Intelligence layer (knowledge base, citations, source monitoring)
├── Source monitoring (weekly, checks .gov URLs for changes)
└── Telegram bot alerts

Supabase (cloud Postgres)
├── Core: inventory_events, sales_by_state, nexus_status, state_rules
├── Calendar: filing_calendar, franchise_tax_flags
├── Intelligence: nexus_rules, franchise_entity_rules, filing_rules
│   court_rulings, admin_rulings, source_registry, source_documents,
│   monitoring_checks, rule_changelog, research_tasks
├── Ops: alerts, audit_log, ingestion_log
└── Read by optional Vercel dashboard

Vercel (optional)
└── Next.js dashboard for viewing flags & marking filings complete
```

**Language choice**: Python — excellent CSV/data handling, mature scheduling libraries (APScheduler), clean Supabase client, and reliable long-running process management on macOS. The Shopify and Telegram integrations have well-maintained Python SDKs.

---

## Prerequisites

- **Python 3.11+** (`brew install python@3.12` on macOS)
- **Supabase account** (free tier works to start): https://supabase.com
- **Telegram bot token** (see setup below)
- **Shopify custom app** with Admin API access (see setup below)
- **Amazon Seller Central** access for report downloads

---

## Data You Need to Gather

**Read this entire section before starting setup.** The agent cannot function without specific reports from your selling platforms. Gather these one-time historical files first, then set up the recurring rhythm.

### Step 1: One-Time Historical Data

#### A. Amazon FBA Inventory History (Physical Nexus Foundation)

This is the most important report. Amazon moves your inventory across fulfillment centers automatically — each state where inventory has been stored may create a physical nexus obligation.

**Report name**: Inventory Event Detail (preferred) or Inventory Ledger (Detail view)

**How to download**:
1. Log in to **Amazon Seller Central**
2. Navigate to: **Reports → Fulfillment → Inventory Ledger**
3. Select the **"Detail"** or **"Event Detail"** view
4. Set date range: from the **earliest date you started using FBA** (or at minimum the last 24–36 months) through today
5. Click **Generate Report** / **Download**
6. Save the file (usually `.txt` or `.csv`) — do NOT rename it yet

**What the agent extracts**: fulfillment-center-id (FC code like DFW7, ONT8, PHL7), dates, quantities, event types. The system maps FC codes to US states automatically.

**Why this matters**: If Amazon stored even one unit in a state's warehouse, that state may consider you to have physical nexus — meaning you may owe sales tax on all sales shipped to that state, potentially retroactively.

#### B. Historical Sales by Destination State

**Amazon sales data**:
1. In Seller Central: **Reports → Business Reports → Sales and Traffic by Date** or **Reports → Tax → Marketplace Tax Collection** (shows tax collected by Amazon by state)
2. Alternatively: **Reports → Fulfillment → All Orders** (includes ship-to state)
3. Download for the last **12–24 months** minimum
4. Any format that includes destination state and order total

**Shopify sales data** (if not using API yet):
1. In Shopify Admin: **Orders → Export**
2. Export **all orders** (or filter to last 12–24 months)
3. The export CSV includes `Shipping Province Code` — that's what we need
4. Save the CSV

#### C. Current Registrations & Filing Frequencies

Create a simple CSV file with your current tax registrations:

```csv
state,registered,filing_frequency,typical_due_day,notes
TX,true,quarterly,20,Registered since 2024
CA,false,,,Not yet registered - evaluating
```

Fields:
- `state`: Two-letter state code
- `registered`: true/false
- `filing_frequency`: monthly / quarterly / annual / not_registered
- `typical_due_day`: Day of month filing is due (most states: 20th)
- `notes`: Any relevant context

If you don't have this ready, the system will start with defaults and flag everything for review.

#### D. Optional: Product Taxability Notes

Most tallow-based skincare products are treated as **taxable tangible personal property** in all states. If you have any products that might qualify for exemptions (e.g., certain health/medical items in some states), note them. The system assumes all products are fully taxable unless configured otherwise.

### Step 2: Recurring / Ongoing Data

#### A. Amazon Inventory Updates (Weekly)

- Download the same **Inventory Event Detail** report from Seller Central
- Set the date range to the **last 30–60 days** (overlap is fine — the system deduplicates)
- Drop the file into: `~/sales-tax-agent/incoming/amazon/`
- The agent watches this folder, processes new files automatically, and moves them to `archive/amazon/`
- **Recommended cadence**: Weekly (every Monday morning is a good rhythm)

#### B. Shopify Sales Data (Automatic via API)

Once the Shopify custom app is configured (see Setup below), the agent polls for new/updated orders **every 4 hours** automatically. No manual action needed.

**Fallback** if API isn't ready: Export orders from Shopify Admin weekly and drop the CSV into `~/sales-tax-agent/incoming/shopify/`.

#### C. Amazon Sales Data (Weekly/Monthly)

- Download order or sales-by-state reports from Seller Central
- Drop into `~/sales-tax-agent/incoming/amazon/`
- The agent distinguishes inventory reports from sales reports by column headers

---

## Setup Instructions

### 1. Clone and Install

```bash
cd ~
# If you received this as a zip/folder, just cd into it:
cd sales-tax-agent

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Create Supabase Project

1. Go to https://supabase.com and create a new project
2. Note your **Project URL** and **anon/service_role key** from Settings → API
3. Open the **SQL Editor** in Supabase Dashboard
4. Copy the contents of `supabase/schema.sql` and run it — this creates the core tables
5. Copy the contents of `supabase/schema_intelligence.sql` and run it — this creates the intelligence layer tables (10 additional tables for rules, rulings, source monitoring)
6. Verify tables were created in the Table Editor

### 3. Create Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow prompts to create your bot
3. Copy the **bot token** (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. Start a chat with your new bot and send any message
5. Get your **chat ID**: visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser — find `"chat":{"id":123456789}` in the response
6. Save both the token and chat ID

### 4. Create Shopify Custom App

1. In Shopify Admin → **Settings → Apps and sales channels → Develop apps**
2. Click **Create an app** → name it "Sales Tax Agent"
3. Click **Configure Admin API scopes** and enable:
   - `read_orders` (required)
   - `read_all_orders` (required for historical data)
   - `read_products` (optional, for SKU-level tracking later)
   - `read_locations` (optional)
4. Click **Install app**
5. Copy the **Admin API access token** (shown only once — save it immediately)
6. Note your shop domain (e.g., `your-store.myshopify.com`)

### 5. Configure Environment

```bash
cp .env.example .env
# Edit .env with your actual values:
nano .env
```

Fill in all required values (see `.env.example` for descriptions).

### 6. Initialize Database

```bash
source venv/bin/activate
python scripts/setup_supabase.py
```

This seeds the state rules matrix, the intelligence layer knowledge base (nexus rules, franchise rules, filing rules, court and admin rulings, and source monitoring URLs), and default filing calendar into Supabase.

### 7. Run Initial Data Ingestion

```bash
# Ingest your historical Amazon inventory report
python ingest.py --amazon path/to/your/inventory-event-detail.csv

# Connect Shopify and pull historical orders
python ingest.py --shopify

# Or if using manual Shopify CSV export:
python ingest.py --shopify-csv path/to/shopify-orders.csv

# Import your registrations (if you prepared the CSV)
python ingest.py --registrations path/to/registrations.csv

# Run the first analysis
python -m src.main analyze
```

### 8. Start the Agent (Long-Running)

```bash
# Start the background agent with folder watcher + scheduler
python -m src.main run

# Or use the provided launchd plist for auto-start on boot (macOS):
cp deploy/launchd/com.tallowbourn.salestax.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tallowbourn.salestax.plist
```

**Daily automation (no terminal needed).** Once that launchd job is loaded the
agent starts at login, restarts itself if it exits, and runs every sync on its
own — so the `/ppc` KPIs, trend chart and Actions queue are already current each
morning. All cron times are **America/New_York**, set explicitly on the
scheduler from `config/business_rules.json` → `agent.timezone`, so changing the
Mac's clock cannot move them (Amazon *day boundaries* stay America/Los_Angeles —
a separate rule). The Ads schedule is 05:00 campaigns (30 days, ≤30-day chunks),
05:30 search terms (7 days, 7-day chunks, 90-minute cap with one retry), 06:00
action-queue rebuild (7 days, 30% target ACOS), plus a Sunday 03:00 90-day
campaign backfill for long trends; SP-API orders and `sales_daily` refresh at
06:00 to keep the TACOS denominator current. The three Ads jobs are separate on
purpose — a slow search-term report can never delay or cancel the campaign
refresh, so a bad night degrades to "current KPIs, yesterday's Actions" and is
recorded as `partial`, not `fail`. Check what actually ran with
`python -m src.main jobs` (add `--failures` to see only problems, or
`--job ads_campaigns_sync` for one job); every run writes a `job_runs` row with
status and timestamps, which is what the dashboard's "last sync" label reads.
Hands-off auto-update is enabled: a 04:30 ET APScheduler job (and a once-on-
startup pass) fast-forwards `origin/main` when the tree is clean, then exits
so launchd `KeepAlive` respawns with the new code. Dirty or diverged checkouts
abort and log; nothing is force-reset. Kickstart is only an emergency
fallback. See `deploy/launchd/README.md`.

---

## FBA Inventory Feed (Physical Nexus)

**This feed decides which states you register in.** Physical nexus is computed
from `inventory_events` — every fulfilment centre that has held your stock, and
when. If the feed stalls, or an FC code has no state mapping, the result is not
an error message: it is a state quietly missing from your nexus list. Treat
inventory freshness as a compliance control, not a data-plumbing detail.

### What runs, and when

| Job | Cadence | Window | Notes |
|---|---|---|---|
| `spapi_refresh` | daily 06:00 (America/New_York) | orders 7d, **inventory ledger 14d** | soft-fails: an inventory error never blocks orders or the sales-tax digest |
| `inventory_ledger_backfill` | Sunday 04:00 | **90d** | catches ledger rows Amazon settled after the daily window moved on |
| `inventory_sync` | daily 10:30 | current stock | FBA/AWD/restock/velocity — *not* the ledger, and not nexus input |

Both ledger jobs write with an **UPSERT** on
`(source_file, event_date, fc_code, asin, event_type, quantity)`. They add and
correct; they never delete. Re-pulling any window — 14 days or 90 — cannot
remove the 2024/2025 history the nexus engine reads. There is a test pinning
this (`tests/test_ledger_health.py::TestHistoryIsNeverTruncated`).

Window sizes live in `config/business_rules.json` under `spapi`:
`inventory_ledger_days` (14) and `inventory_ledger_backfill_days` (90).

### Routine check — no terminal needed most days

The daily Telegram digest prints **one line** if the ledger has not synced
successfully in 36 hours, and escalates past 72. A healthy feed prints nothing:
a warning that appears every morning is one nobody reads on the morning it
matters.

When you do want detail:

```bash
python -m src.main inventory-health
```

Shows last successful sync, latest `event_date`, total events, distinct states,
events by year, and any unmapped FC codes with their event counts and date
ranges.

### Unmapped FC codes — the silent gap

`state_code` is resolved **at parse time** from `config/fc_codes.json`. Two
consequences:

1. An FC code that is not in that file produces an event with **no state**,
   invisible to the physical-nexus engine. You could be storing inventory in a
   state and see no nexus for it.
2. Adding the code later does **not** retroactively fix stored rows.

So the fix is two steps:

**Never infer the state from the letters in the code.** Two worked examples
from the 2026-08-20 mapping pass:

- `XMD5` is in **Greencastle, Pennsylvania** — not Maryland.
- `XCH2` is in **Garden City, Georgia** — not Chicago.
- `ABE2/ABE3/ABE4` are in **Pennsylvania**; only `ABE8` (Florence NJ) is New
  Jersey. The whole family had been mapped to NJ, misattributing 365 events.

The `S` prefix is inconsistent too: `SAZ`/`SCA`/`SCO` encode states, but
`SAT`/`SBD`/`SBN`/`SCK` are airport codes. Published directories also contain
errors — one listed `SYS3` as "NC" with a Tennessee ZIP. **Always check the ZIP
against the state**, and prefer leaving a code unmapped over guessing.

```bash
# 1. Find the state. Seller Central > Inventory > Shipments shows the
#    destination address for each FC. Verify the ZIP matches the state.
# 2. Add "CODE": "XX" to config/fc_codes.json AND mirror it into
#    dashboard/src/lib/parsers/fc-codes-data.json, then backfill stored rows:
python -m src.main inventory-remap-fc --dry-run   # shows what would change
python -m src.main inventory-remap-fc --apply
python -m src.main analyze                        # pick up any new states

# If you CORRECTED a mapping that was already wrong, the fill-in pass cannot
# see those rows (they already have a state). Use --recheck to fix them:
python -m src.main inventory-remap-fc --recheck --dry-run
python -m src.main inventory-remap-fc --recheck --apply
```

`inventory-remap-fc` only fills in states that are currently missing. It never
overwrites an existing mapping and never deletes a row.

### Keeping the scheduler alive on the Mac Mini

The jobs above only run while the agent process is running. Two ways:

```bash
# Foreground / ad-hoc — stops when the terminal closes:
python -m src.main run

# Persistent, survives reboot (this is the one you want):
launchctl load -w ~/Library/LaunchAgents/com.tallowbourn.salestax.plist
launchctl list | grep tallowbourn      # confirm it is loaded
```

Check it is actually working:

```bash
python -m src.main jobs               # recent job outcomes
python -m src.main inventory-health   # freshness of this specific feed
tail -f logs/agent.out.log
```

If `inventory-health` reports STALE, the scheduler is almost always the cause —
check `launchctl list` before investigating Amazon.


---

## Organic Rank for PPC (Brand Analytics SQP)

The PPC action plan will not raise bids hard on queries we already win
organically. Rank comes from **Brand Analytics Search Query Performance**,
pulled automatically each week over SP-API.

**The Advertising API does not publish organic rank.** It has no organic signal
at all. SQP is a **Reports API** report on the SP-API side:
`GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`.

### What SQP actually gives us

SQP reports **click share and impression share** per query — not a SERP
position. So rank here is a derived **band**, never a measured position:

| Click share | Band recorded | Gate tier |
|---|---|---|
| ≥ 40% | 1 | top-3: cap increases at +8% |
| ≥ 15% | 5 | positions 4–7: cap at +12% |
| < 15% | 99 | full plan increase allowed |

Click share is used rather than impression share because it reflects where
shoppers actually went — closer to "would we have won this click anyway" than
"we were shown". A query with no share data yields **no row**, not a guess.

This is a **cannibalization guard, not incrementality**. It says we may already
get a click for free; it cannot say a given ad click was wasted. Only a holdout
test can.

### ASINs — the thing that silently breaks this

SQP is requested per ASIN. SP-API accepts ASINs it does not recognise and
returns an **empty report**, which is indistinguishable from "quiet week"
unless someone checks. That happened here: the shipped defaults were parent-ASIN
title overrides from `asin_titles.json` that appear in no table, and the first
live run returned zero rows despite valid auth and the role being granted.

`resolve_asins()` now validates the configured list against `inventory_events`
(the catalog of record — `sku_costs.asin` is unpopulated and there is no
products table) on every run, and falls back to the most active real ASINs with
a loud warning if none of the configured ones are recognised. `sqp-sync` prints
which ASINs were requested and on what basis (`config` / `catalog_fallback`).

### Publish lag

Amazon publishes SQP roughly **24–48 hours** after a period closes. If the most
recent complete week returns nothing, the sync retries the **previous** complete
period once and reports which period actually supplied the data. An empty week
is therefore never mistaken for a broken pipeline.

### Ads spend: as-of rule and scope

Every ads window on `/ppc` is **closed days ending yesterday in
America/Los_Angeles** — never a rolling window that includes today. Today is
still accruing: including it would make every KPI drift downward through the
day and never match a console figure pulled at a different hour. "7D" therefore
means seven whole closed LA days.

Two reconciliation rules, both checkable with one command:

```bash
python -m src.main ads-spend-audit --expect-spend 3010.34
```

1. **Header spend covers all ad products the account runs** — Sponsored
   Products **+ Brands + Display**, matching what Seller Central totals. If
   SB/SD rows are missing for a window, `/ppc` says so under the KPI strip
   rather than quietly reporting an SP-only number as the total.
2. **Placement data is Sponsored Products only.** Amazon publishes placement
   breakdowns for SP campaigns; there is no SB/SD equivalent. So placement rows
   legitimately sum to less than the header, and the difference is shown as an
   explicit **unallocated** figure instead of leaving two panels disagreeing.

Worked example (7 closed days ending 2026-08-20):

| | |
|---|---|
| Console | $3,010.34 |
| Agent total | $3,010.34 (SP $2,800.73 + SB $203.85 + SD $5.76) |
| Placement rows | $2,800.73 |
| Unallocated (SB/SD, no placement data) | $209.61 |

**Re-sync once** if the header looks low:

```bash
python -m src.main ads-sync --days 7 --campaigns-only --ad-products SB,SD
python -m src.main ads-spend-audit --expect-spend <console figure>
```

SB/SD reports on this account intermittently sit in PENDING; when they do, the
sync soft-fails, SP data is kept, and the header note makes the omission
visible rather than silent.

### Report quota

SQP report requests are tightly rate-limited. Three ad-hoc `sqp-sync` runs in
quick succession returned `QuotaExceeded`. The weekly schedule sits well inside
the limit; **ad-hoc re-runs are what exhaust it** — so use `--dry-run` sparingly
and prefer the *Sync SQP now* button only when you actually need fresh data.

A quota error is detected explicitly and reported as a rate limit, not as an
empty period, and it suppresses the previous-period retry (retrying would spend
the quota that just ran out).

### Brand rename (2025-10-31)

The brand was renamed **"Dr. Dave's Primal Essence" → "Tallowbourn"** around
2025-10-31, on the **same ASINs**. Both eras' terms classify as **branded**, so:

- **mix and share stay continuous** across the boundary — treating only the new
  name as brand would render the rename as a brand-demand collapse followed by a
  surge of "non-brand" purchases that were never non-brand
- **bid caps apply to legacy searches too** — someone searching the old name is
  still brand demand we already own

Term list (`config/brand_terms.json`, whole-word/phrase matching):

| Era | Terms |
|---|---|
| current | tallowbourn, tallowbourne, tallowborn, tallowbourns, tallowbournes, tallow bourne, tallow bourn |
| legacy | dr dave, dr daves, dr dave's, dr. dave, dr. daves, dr. dave's, doctor dave, primal essence, dr dave('s) primal essence |

Deliberately **excluded** as generic: `tallow`, `dave`, `primal`, `essence` on
their own. `beef tallow lip balm` is a non-brand category query; only the phrase
`primal essence` is branded, not `primal` or `essence` alone. A false positive
here would cap bids on exactly the head terms we want to win.

**After editing the term list**, stored rows keep their old classification —
`is_branded` is written at ingest. Refresh with:

```bash
python -m src.main brand-reclassify            # dry run: shows the flips
python -m src.main brand-reclassify --apply
python -m src.main brand-share                 # corrected mix
python -m src.main ads-actions                 # bid caps pick up new brand terms
```

No Amazon calls, so it costs no SQP quota.

### Weekly PPC cadence

```bash
python -m src.main ppc-playbook
```

Prints this week's decisions in order, with the live figures behind each. Also
rendered on **/ppc** as *This week's playbook*.

1. **Monday 10:00 America/Los_Angeles** — SQP auto-sync runs (after Amazon
   publishes the prior Sun–Sat week)
2. `ads-actions` — rebuild recommendations so the rank gate sees fresh bands
3. **P0 first**: negatives and high-ACOS placement cuts (Detail Page is usually
   the biggest lever). Recovered budget, reversible, immediate
4. **P2 next**: non-brand raises that passed *both* the ACOS rules and the rank
   gate
5. **Leave `needs_rank_check` manual** — above the high-bid threshold with no
   rank on file; raising blind is what the gate exists to prevent
6. **Never scale brand terms as a growth lever** — cap and move on

### Multi-week backfill (for trends)

The weekly job only moves forward. Branded-vs-non-branded trends and rank-band
history need several weeks, so there is a separate backfill that walks
completed Sun–Sat weeks **backward, one report request at a time**.

```bash
python -m src.main sqp-backfill --max-weeks 4              # dry run: lists weeks
python -m src.main sqp-backfill --max-weeks 4 --apply      # fetches them
python -m src.main sqp-backfill --from 2026-06-01 --to 2026-08-15 --apply
```

**Recommended cadence: about 4 weeks per day until caught up.** This is not an
instant history load, and that is deliberate — SQP report requests are tightly
rate-limited and three ad-hoc calls in quick succession already produced
`QuotaExceeded`.

Safety properties, all test-pinned:

| Flag | Default | Why |
|---|---|---|
| `--max-weeks` | 4 | one invocation cannot burn the day's quota |
| `--sleep` | 90s | spacing between report requests |
| `--resume/--no-resume` | resume | weeks already stored are skipped, not re-fetched |
| `--dry-run/--apply` | dry-run | you see the week list before spending quota |
| `--refresh-actions` | off | rebuilds recommendations **once at the end**, not per week |

On `QuotaExceeded` the walk **stops immediately** — it never retries the failed
week, because retrying into a rate limit is what turns one refusal into a
lockout. Weeks already written are kept, and the command prints when and how to
resume. Re-running the identical command skips completed weeks automatically.

`--to` is clamped to the last complete week; an in-progress week is never
requested.

**Progress is derived from the data**, not from a stored cursor: the backfill
reads which `as_of` / `week_end` values already exist in
`keyword_organic_rank` and `sqp_weekly`. A cursor can drift out of sync after a
partial write or a manual delete — the rows cannot.

**Where to run it:** on the Mac Mini agent (it needs SP-API credentials and can
run for minutes). Not from the dashboard — the /ppc card shows how many weeks
are stored and suggests the command, but there is deliberately no one-click
bulk-load button that could burn the quota in a single tap.

### Permissions checklist

1. Seller Central → **Apps & Services → Develop Apps** → your existing SP-API app
2. **Edit app** → add the **Brand Analytics** role (alongside existing roles)
3. **Brand Registry** must be active for the brand
4. **Re-authorize the app.** An existing refresh token does *not* gain new roles
   — this is the step people miss
5. Test: `python -m src.main sqp-sync --dry-run`

A missing role fails loudly with these steps printed. It never silently writes
zero rows: that would look identical to "no data this week" and would leave the
gate permanently blind.

### Schedule

Weekly, **Monday 10:00 America/Los_Angeles** — after Amazon publishes the prior
Sunday–Saturday week. `dataStartTime`/`dataEndTime` are aligned to complete
period boundaries; an in-progress week is never requested. ASINs are batched to
respect SP-API's 200-character `reportOptions.asin` limit (18 per request).

Configure in `config/ads_strategy.json` → `organic_rank_gating.sqp_auto`
(`enabled`, `asins`, `report_period`, `schedule`, `on_success_refresh_ads_actions`).

With `on_success_refresh_ads_actions: true` the job rebuilds recommendations
after a successful pull, so fresh ranks reach the plan immediately. Otherwise
the next `ads-actions` run picks them up.

### Checking it without a terminal

The **/ppc** page has an *Organic rank data (Brand Analytics SQP)* card showing
last sync date, age, keyword count, sources, ASINs covered, and the schedule —
plus a **Sync SQP now** button. Rank older than `stale_after_days` (14) is
badged **stale** and the gate treats it as *unknown*, holding high bids for a
manual check rather than raising on old data.

PPC action rows show a badge: *High cannibalization risk (org #N)*, *Rank check
needed*, or *Rank unknown*. Badges appear on bid **increases** only.

CLI equivalents (debugging): `sqp-status`, `sqp-sync [--period WEEK] [--apply]`,
`rank-set "<keyword>" <rank>`, `sqp-import <csv>` for a manual CSV.


---

## Running the System

### CLI Commands

```bash
# Full nexus analysis + summary
python -m src.main analyze

# View current nexus status
python -m src.main status

# View upcoming filing deadlines
python -m src.main deadlines

# Mark a filing as complete
python -m src.main complete --state TX --period 2026-Q2

# Generate filing calendar for all registered states
python -m src.main generate-filings

# Backfill Shopify SKU data (product-level sales)
python -m src.main backfill-shopify-skus

# Export sales data as CSV for CPA
python -m src.main export-csv --table sales_by_state --start 2026-01-01
python -m src.main export-csv --table sales_by_sku --start 2026-01-01

# SP-API: pull Amazon orders + inventory
python -m src.main spapi-refresh --days 30

# FBA inventory feed health (drives physical nexus — see section above)
python -m src.main inventory-health

# Backfill state_code after adding codes to config/fc_codes.json
python -m src.main inventory-remap-fc --apply

# Amazon Ads: sync campaigns + search terms
#   campaigns  chunk at <=30 days; search terms chunk at 7 days (much heavier)
python -m src.main ads-sync --days 14

# Just the fast half — campaign dailies for the KPI cards and trend chart.
# Returns in ~30s and never waits on a search-term report.
python -m src.main ads-sync --days 30 --campaigns-only

# Just the slow half — search terms for the Actions queue (90-min cap, 1 retry)
python -m src.main ads-sync --days 7 --search-terms-only
python -m src.main ads-sync --days 14 --search-terms-only --search-term-chunk-days 7

# 90-day PPC backfill — fills ads_campaigns_daily so the /ppc trends chart and
# its 90D range have real history. Issues 3 chunked campaign report requests
# (30 + 30 + 30 days). Runs automatically every Sunday at 03:00.
python -m src.main ads-sync --days 90 --campaigns-only

# Rebuild the PPC action queue (also runs automatically at 06:00 daily)
python -m src.main ads-actions --target-acos 30 --days 7

# What the scheduled agent has actually done
python -m src.main jobs
python -m src.main jobs --failures

# Start the background agent (folder watcher + scheduler + API polling)
python -m src.main run

# Test Telegram notifications
python -m src.main test-alert
```

### Dashboard Pages

| Page | Route | Purpose |
|------|-------|---------|
| **Pulse** | `/` | Daily command center: MTD/last month sales, open actions, deadlines, quick links |
| **What Do I Owe?** | `/liability` | Shopify-focused tax liability estimates per registered state |
| **Filing Calendar** | `/calendar` | Track + mark filings complete; bulk-mark overdue |
| **Registrations** | `/registrations` | Manage state registrations, frequency, last filed through |
| **Nexus Monitor** | `/nexus` | Unregistered exposure: physical + economic nexus by state |
| **Sales Map** | `/sales-map` | US choropleth by sales volume; year + month + channel filters |
| **SKU Performance** | `/skus` | Product-level sales, units, refunds by SKU |
| **Rules & Rulings** | `/rules` | Cited nexus rules, court opinions, admin guidance |
| **Data & Export** | `/data` | Upload CSV, trigger SP-API refresh, download CPA exports |

### Folder Watcher

The agent watches `~/sales-tax-agent/incoming/` for new files:

- `incoming/amazon/` — Drop Amazon inventory or sales CSV/TXT files here
- `incoming/shopify/` — Drop Shopify order CSV exports here (fallback if API not configured)

Files are processed automatically, then moved to `archive/` with a timestamp prefix.

---

## Intelligence Layer

The intelligence layer is a structured knowledge base of state-specific nexus rules, court rulings, administrative guidance, franchise tax positions, and filing rules. Every rule carries **citations to primary sources**, a **confidence level**, and **provenance tracking**.

### Non-Negotiable Principles

- **Every rule must carry citations.** No rule enters the knowledge base without at least one primary source.
- **Primary sources preferred.** Statutes, regulations, agency guidance, and court opinions — not blog posts.
- **Contested positions are never presented as settled law.** If a state's position is litigated or uncertain, both conservative and aggressive readings are shown.
- **Disclaimers appear everywhere.** Every query, report, and alert includes: *"This is a monitoring and research aid, not legal or tax advice."*

### CLI Commands

```bash
# Full state nexus profile with citations
python -m src.main query-state CA

# Search rulings by keyword
python -m src.main search-rulings wayfair

# List all contested positions
python -m src.main contested

# Generate a Rules Health Report
python -m src.main health-report

# Run source monitoring (checks .gov URLs for changes)
python -m src.main monitor-sources

# List open research tasks
python -m src.main research-tasks
```

### incoming/rulings/ Folder

Drop ruling files into `~/sales-tax-agent/incoming/rulings/`:

- **JSON files** — structured rulings with `court_ruling` or `admin_ruling` keys are ingested directly
- **PDF, HTML, TXT files** — registered as raw documents for LLM-assisted extraction with mandatory human review

### Rules Health Report

Run monthly (`python -m src.main health-report`) to see:

- **Stale rules** not reviewed within 90 days
- **Contested positions** needing CPA attention
- **Unreviewed source changes** from the monitoring system
- **Open research tasks** from document extraction or source changes
- **Coverage gaps** — states without detailed intelligence-layer rules
- **Recommended actions** prioritized by urgency

### Source Monitoring

The agent checks 21+ curated URLs (official .gov sites, SST, Tax Foundation) weekly for content changes. When a page changes:

1. A `monitoring_checks` record is created
2. A `research_task` is opened for human review
3. A Telegram alert is sent

This catches threshold changes, new guidance, and rule updates before they affect your compliance posture.

### Knowledge Base Structure

| Table | Purpose |
|-------|---------|
| `nexus_rules` | Detailed per-state FBA/economic nexus positions with citations |
| `franchise_entity_rules` | Franchise tax, B&O tax, CAT obligations per state |
| `filing_rules` | Filing frequencies, due dates, zero-return requirements |
| `court_rulings` | Court opinions with holdings, status, key quotes |
| `admin_rulings` | Agency guidance, comptroller letters, OTA decisions |
| `source_registry` | Curated URLs monitored for changes |
| `source_documents` | Raw documents registered for extraction |
| `monitoring_checks` | Change detection history |
| `rule_changelog` | Audit trail for all knowledge base changes |
| `research_tasks` | Work items requiring human review |

### Database Setup

After creating the intelligence tables (`supabase/schema_intelligence.sql`), seed the knowledge base:

```bash
python scripts/setup_supabase.py
```

This seeds nexus rules (12 rules across CA, TX, PA, WA, NY, NJ, OH, FL, IL), franchise rules (CA, TX, WA, OH, TN, NV), filing rules (7 states), court rulings (Wayfair, OMG v. Hassell, Quill, Tyler Pipe, CA OTA), admin rulings (OK, TX, CA, SST, WA), and 21 monitored source URLs.

---

## Dashboard

A Next.js dashboard for managing compliance data, registrations, file uploads, nexus flags, filing deadlines, and the intelligence layer's rules and rulings. Every screen includes the standard disclaimer: *"This is a monitoring and research aid, not legal or tax advice."*

### Screens

| Screen | What it shows |
|--------|--------------|
| **Overview** | Stat cards (physical nexus count, economic nexus status, upcoming deadlines, open flags), upcoming filings, recent alerts, franchise tax flags |
| **Nexus Status** | Per-state table with physical/economic nexus badges, economic progress bars, registration status, confidence levels. Filterable with Active/Approaching/Below Threshold tabs |
| **Registrations** | Manage sales tax registrations for all 45 sales-tax states. Toggle registered on/off, set filing frequency (monthly/quarterly/annual), set due day, add free-text notes. Saves directly to Supabase — no CSV upload required. Highlights states with nexus that are not yet registered |
| **Filing Calendar** | Overdue/upcoming/completed counts, tabbed filing table with "Mark Complete" action (records amount and notes) |
| **Rules & Rulings** | Searchable knowledge explorer — nexus rules with citations and contested position blocks, court rulings with status and FBA relevance, admin rulings with issuing bodies |
| **Data & Ingestion** | Upload Amazon reports (CSV/TXT) directly from the browser with drag-and-drop. Files are parsed in TypeScript and written to Supabase. Shows upload progress, success/error details, states found, and unknown FC codes. Also shows data source status (Amazon FBA, Shopify), ingestion history, open research tasks, and the legacy drop-into-incoming/ method for power users |

### Running Locally

```bash
cd dashboard
cp .env.example .env.local
# Edit .env.local with your Supabase URL and anon key
npm install
npm run dev -- --port 3001
```

Open http://localhost:3001. The dashboard shows a setup prompt until Supabase credentials are configured.

### Deploy to Vercel

1. Push the `dashboard/` directory to a Git repository (or use the monorepo root)
2. Import the project in Vercel — set the root directory to `dashboard/`
3. Add environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optionally `SUPABASE_SERVICE_KEY` (for server-side upload route writes)
4. Deploy

### Features

- **Registrations management** — toggle registration status, set filing frequency and due day, add notes per state. Writes directly to `nexus_status` and `state_rules` tables in Supabase
- **File upload** — drag-and-drop Amazon Inventory Event Detail or Custom Combined Tax reports (CSV/TXT) from the Data & Ingestion page. Parsed in TypeScript, batched and upserted into `inventory_events`, with ingestion and audit logging
- **Dark mode** — toggle in the sidebar footer, persists via localStorage
- **Responsive** — desktop sidebar collapses to a mobile drawer on small screens
- **Status colors** — green/amber/red/blue for nexus status, deadlines, confidence, and contested positions
- **Supabase-connected** — all data fetched live from the same Supabase instance the agent writes to
- **Human-in-the-loop** — the dashboard is a monitoring interface, not an autonomous actor. Filing completions and registrations are recorded as user-confirmed actions

---

## Daily Use (With SP-API Connected)

### What runs automatically

When the agent is running (`python -m src.main run`):

| Time | Task | What it does |
|------|------|-------------|
| Daily 06:00 | SP-API refresh | Pulls last 7 days of Amazon orders + inventory |
| Every 4h | Shopify poll | Pulls recent Shopify orders |
| Daily 08:00 | Nexus analysis | Physical + economic nexus evaluation; Telegram alerts |
| Daily 09:00 | Deadline check | Alerts on filings due within 3 days or overdue |
| Monday 07:00 | Source monitor | Checks .gov sources for rule changes |

**No manual CSV downloads are needed** when SP-API is connected. The agent keeps Amazon + Shopify data current automatically.

### What to check in the dashboard

1. **Overview** — look for red cards (overdue filings, exceeded thresholds, critical flags)
2. **Tax Liability** — estimated seller-owed tax per state, filing frequency, next due date
3. **Filing Calendar** — mark filings complete after submitting returns to each state
4. **Registrations** — update when you register or deregister in a state

### When to talk to your CPA

- **CA franchise tax**: $800/year LLC tax applies if FBA inventory has been in CA. Separate from sales tax, separate agency (FTB). Most commonly overlooked obligation.
- **TX franchise tax**: Must file No Tax Due report + PIR by May 15 annually, even if $0 owed. Failure = forfeiture of right to do business.
- **Any state exceeding economic nexus**: Registration required. CPA advises on effective date and back-filing.
- **PA nexus**: Contested — Online Merchants Guild v. Hassell (2023). Most practitioners still recommend registration.
- **WA B&O tax**: Separate from sales tax, NOT covered by Amazon marketplace collection. 0.471% on gross receipts.

### Maintenance Rhythm

**Weekly (~2 min):** Check Telegram alerts. Review any new nexus flags in dashboard.

**Monthly (~10 min):** After filing returns, mark them complete in Filing Calendar. Run `python -m src.main health-report` to check rule currency.

**Quarterly:** Discuss flags with CPA. Update registrations. Review contested positions (`python -m src.main contested`).

### Data Source Priority

| Source | Type | Status |
|--------|------|--------|
| `amazon_spapi` | SP-API (live) | **Primary** Amazon source |
| `shopify_api` | Shopify API (live) | **Primary** Shopify source |
| `amazon_custom_combined_tax` | CSV upload | Historical / backfill. Superseded by SP-API. |
| `amazon_inventory` | CSV upload | Legacy. Superseded by SP-API Inventory Ledger. |

---

## Configuration Reference

### State Rules (`config/state_rules.json`)

Each state entry includes:
- `economic_threshold_amount`: Dollar threshold (most states: $100,000)
- `economic_threshold_transactions`: Transaction count threshold (being phased out in many states)
- `economic_threshold_period`: Lookback period (current or prior calendar year)
- `fba_inventory_creates_nexus`: Whether FBA inventory storage creates physical nexus
- `marketplace_sales_count_toward_threshold`: Whether Amazon marketplace sales count toward seller's own economic nexus
- `filing_frequency_default`: Typical assigned frequency for new registrants
- `typical_due_day`: Day of month returns are due
- `franchise_tax_notes`: Entity-level tax implications
- `last_reviewed`: Date this rule was last verified
- `notes`: Nuances, court rulings, or special considerations

### FC Codes (`config/fc_codes.json`)

Maps Amazon fulfillment center codes (e.g., "DFW7") to US states. This is extensible — unknown codes are flagged for manual mapping.

---

## Limitations & Disclaimers

- **Not tax advice.** This system is a monitoring and alerting tool. It does not constitute legal or tax advice. Always consult a qualified CPA or tax attorney before making filing decisions.
- **Rules change.** State tax laws, thresholds, and enforcement positions evolve. The intelligence layer's knowledge base must be reviewed and updated periodically. Run `python -m src.main health-report` monthly to catch stale rules.
- **Nexus is complex.** Physical nexus from FBA inventory is an area of active interpretation. Some states are aggressive (California), others more lenient. Court rulings (e.g., Pennsylvania's Online Merchants Guild v. Hassell) add nuance. The system flags conservatively and presents both sides of contested positions.
- **Contested positions are never presented as settled law.** When a state's FBA nexus position is under litigation or has conflicting guidance, the system shows both conservative and aggressive readings with citations. Never assume a contested position is resolved.
- **No auto-filing.** This system will never submit returns or remit payments. It recommends actions and requires human confirmation.
- **Amazon data limitations.** Without SP-API integration, Amazon data relies on manual report downloads. Some reports may not capture all inventory movements.
- **Marketplace facilitator laws.** Amazon collects and remits sales tax as a marketplace facilitator in all states that require it. However, the seller may still have filing obligations (zero returns, franchise taxes, etc.) in states where they have nexus.
- **Intelligence layer coverage.** The seeded knowledge base covers high-priority states with detailed citations. States without intelligence-layer rules fall back to base state_rules data with lower citation depth. Coverage gaps are reported in the Rules Health Report.
- **LLM-assisted extraction requires human review.** When raw documents (PDFs, HTML) are processed through the extraction pipeline, all proposed updates are flagged as research tasks requiring manual verification before entering the knowledge base.

---

## Known Limitations & Confidence Notes

### Tax liability estimates
- **Base state-level rates only.** Local/county/city surcharges (1-4% additional) are not included. Liability figures are planning estimates, not filing-ready numbers.
- **Seller liability = Shopify/direct sales only.** Amazon collects and remits as marketplace facilitator in all states. The "What Do I Owe?" page shows Shopify sales × base rate. Amazon volume is shown for reference and nexus threshold tracking, not as seller liability.

### Economic nexus
- **Marketplace sales inclusion is state-specific.** Some states (CA, TX, NY, OH, etc.) include marketplace sales toward the seller's threshold. Others (FL, VA, GA, IL, etc.) exclude them. Each state's rule is cited in `config/state_rules.json`.
- **AND vs OR thresholds.** NY requires BOTH $500k AND 100+ transactions. CT requires BOTH $100k AND 200 transactions. All others use OR. The engine honors this per state.
- **Lookback periods vary.** Most states use current/prior calendar year. CT uses 12 months ending Sep 30. VT and NY use trailing 4 quarters. The engine computes per-state windows.

### Physical nexus (FBA)
- **PA FBA nexus is contested.** Online Merchants Guild v. Hassell (2022) found FBA inventory alone insufficient. Flagged conservatively.
- **8 states have FBA carve-outs** (AZ, AR, IA, IL, ND, NV, NY, OK) — marketplace-facilitator inventory storage does not create seller nexus. TX is conditional.
- **FBA nexus ≠ must collect on Amazon orders.** Amazon already remits as marketplace facilitator. Physical nexus matters for registration decisions, not for duplicate collection.

### SKU-level data
- **Amazon refunds may be incomplete.** The SP-API orders report does not reliably include return data. Amazon refunds show as "—" or 0 with a note, not false accuracy. Connect Amazon returns/settlement reports for complete refund visibility.
- **Shopify refunds** are from order refund line items in the API backfill. Refund accuracy depends on the order data scope.
- **SKU totals ≠ state totals.** SKU data is aggregated from line items (price × quantity per line), while state data uses order subtotals. Discounts, multi-item orders, and rounding can cause differences. The integrity-check command reports the gap.

### System behavior
- **The system does not file returns.** It monitors and estimates. All filing decisions should involve a qualified CPA.
- **Sticky nexus is cleared** when current data no longer meets the threshold under current rules. Prior exceedances are noted for CPA review.
- **Data freshness depends on polling schedule.** The background agent refreshes Shopify and Amazon daily. The Pulse page shows last sync times. Stale data (>36h) is flagged.

## Future Phases

1. **Commercial Tax Engine** — Integrate TaxJar or Avalara for rate calculation and assisted filing
2. **Multi-Entity Support** — Handle multiple LLCs or business structures
3. **Historical Nexus Analysis** — Determine retroactive obligations and voluntary disclosure program options
4. ~~**Amazon SP-API Integration**~~ — Done. Orders + Inventory Ledger with auto-chunking.
5. ~~**Vercel Dashboard**~~ — Done. See [Dashboard](#dashboard) section

---

## Daily Autonomous Loop

The agent runs on a Mac Mini via launchd (`com.tallowbourn.salestax`). It starts on boot and restarts on crash.

| Job | Schedule | What it does |
|---|---|---|
| shopify_poll | Every 2h | Fetch Shopify orders → sales_by_state |
| spapi_refresh | 06:00 daily | Amazon SP-API orders + inventory ledger |
| inventory_sync | 06:30 daily | FBA snapshots + restock + AWD |
| 3pl_sync | 06:35 daily | Ship Sidekick 3PL stock |
| cpa_exports | 06:30 daily | Generate CPA export PDFs/CSVs |
| daily_analysis | 08:00 daily | Run nexus engines + policy alerts |
| daily_digest | 08:05 daily | Telegram morning summary |
| deadline_check | 09:00 daily | Log upcoming filing deadlines |
| source_monitoring | Mon 07:00 | Check state DOR page changes |
| job_worker | Every 45s | Process async export jobs |

## What You Still Do Manually

- **File returns**: The system calculates what you owe. You or your CPA file with each state's DOR portal.
- **Register in new states**: The system recommends when to register. You complete registration on the state website or via SST.
- **Review CPA notes**: Franchise tax (CA $800, TX PIR), B&O (WA), and contested positions need CPA confirmation.
- **Confirm Seller Central**: Daily Amazon totals should match SC Business Reports (item-price, Pacific tz).
- **Inventory reorders**: The system forecasts demand. You decide production quantities and create inbound shipments.

## Tax Channel Rules

| Channel | Source | Who Remits | In Seller Liability? |
|---|---|---|---|
| shopify (Online Store) | source_name="web" | **Seller** | Yes |
| shopify_shop (Shop channel) | source_name=numeric app ID | **Shopify** | No (marketplace) |
| amazon | SP-API orders | **Amazon** | No (marketplace) |

Shop Pay on your website is NOT the Shop channel. A customer using Shop Pay to check out on your Online Store = `source_name="web"` = seller-responsible.
