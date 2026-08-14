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
├── Folder watcher: ~/sales-tax-agent/incoming/
│   ├── amazon/   ← drop Amazon CSV/TXT reports here
│   ├── shopify/  ← optional manual CSV fallback
│   └── rulings/  ← drop ruling JSON, PDF, HTML, or TXT here
├── Intelligence layer (knowledge base, citations, source monitoring)
├── Shopify API polling (daily)
├── Source monitoring (weekly, checks .gov URLs for changes)
└── Telegram bot + email alerts

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
cp scripts/com.salestax.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.salestax.agent.plist
```

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

# Export report for CPA review
python -m src.main export --format csv --output report.csv

# Start the background agent (folder watcher + scheduler + API polling)
python -m src.main run

# Test Telegram notifications
python -m src.main test-alert
```

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

A polished Next.js dashboard for viewing compliance data, reviewing nexus flags, tracking filing deadlines, and exploring the intelligence layer's rules and rulings. Read-only with light write actions (mark filings complete, add notes). Every screen includes the standard disclaimer: *"This is a monitoring and research aid, not legal or tax advice."*

### Screens

| Screen | What it shows |
|--------|--------------|
| **Overview** | Stat cards (physical nexus count, economic nexus status, upcoming deadlines, open flags), upcoming filings, recent alerts, franchise tax flags |
| **Nexus Status** | Per-state table with physical/economic nexus badges, economic progress bars, registration status, confidence levels. Filterable with Active/Approaching/Below Threshold tabs |
| **Filing Calendar** | Overdue/upcoming/completed counts, tabbed filing table with "Mark Complete" action (records amount and notes) |
| **Rules & Rulings** | Searchable knowledge explorer — nexus rules with citations and contested position blocks, court rulings with status and FBA relevance, admin rulings with issuing bodies |
| **Data & Ingestion** | Data source status (Amazon FBA, Shopify), ingestion history, open research tasks, instructions for adding data |

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
3. Add environment variables: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy

### Features

- **Dark mode** — toggle in the sidebar footer, persists via localStorage
- **Responsive** — desktop sidebar collapses to a mobile drawer on small screens
- **Status colors** — green/amber/red/blue for nexus status, deadlines, confidence, and contested positions
- **Supabase-connected** — all data fetched live from the same Supabase instance the agent writes to
- **Human-in-the-loop** — the dashboard is a monitoring interface, not an autonomous actor. Filing completions are recorded as user-confirmed actions

---

## Maintenance Rhythm

### Weekly (5 minutes)

1. **Monday**: Download Amazon Inventory Event Detail for the last 30–60 days from Seller Central
2. Drop the file into `~/sales-tax-agent/incoming/amazon/`
3. Check Telegram for any new alerts from the past week
4. Review any new nexus flags — decide if action is needed with your CPA
5. Check for source monitoring alerts (automatic if agent is running; manual: `python -m src.main monitor-sources`)

### Monthly (15 minutes)

1. Download Amazon sales/order reports for the prior month
2. Drop into `~/sales-tax-agent/incoming/amazon/`
3. Run `python -m src.main analyze` for a full summary
4. Review upcoming filing deadlines (`python -m src.main deadlines`)
5. After filing returns, mark them complete (`python -m src.main complete --state XX --period YYYY-QN`)
6. Export a report for your CPA if needed (`python -m src.main export`)
7. Run `python -m src.main health-report` — review stale rules, open research tasks, and coverage gaps
8. Address any open research tasks (`python -m src.main research-tasks`)

### Quarterly

1. Review the state rules matrix for any threshold or rule changes
2. Discuss flags and recommendations with your CPA
3. Update registrations if you've registered in new states
4. Review contested positions with CPA (`python -m src.main contested`)

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

## Future Phases

1. **Amazon SP-API Integration** — Automate inventory and sales data retrieval (eliminates manual downloads)
2. **Browser Automation** — Selenium/Playwright fallback for Seller Central report downloads
3. **Commercial Tax Engine** — Integrate TaxJar or Avalara for rate calculation and assisted filing
4. **Deeper Franchise Tax Rules** — Expand beyond CA/TX to all states with entity-level implications
5. **Multi-Entity Support** — Handle multiple LLCs or business structures
6. ~~**Vercel Dashboard**~~ — Done. See [Dashboard](#dashboard) section
7. **Historical Nexus Analysis** — Determine retroactive obligations and voluntary disclosure program options
