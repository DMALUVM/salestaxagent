# Sales Tax Agent — CLAUDE.md

## Project

Python CLI + Next.js dashboard for sales tax compliance, Amazon/Shopify
operations, PPC intelligence, demand forecasting, and contribution P&L.

- Python CLI: `src/main.py` (Click framework)
- Dashboard: `dashboard/` (Next.js App Router, shadcn/ui)
- Database: Supabase (PostgREST)
- Scheduler: APScheduler (BlockingScheduler)

## NON-NEGOTIABLE Business Rules

**Read `config/business_rules.json` for canonical values.**
**Use `src/rules.py` for all constants — no hardcoded duplicates.**

1. **Amazon timezone**: `America/Los_Angeles` for ALL day boundaries.
   Using any other timezone causes Seller Central mismatches.

2. **Order statuses**: Include Pending, Unshipped, PartiallyShipped, Shipped.
   Exclude ONLY Cancelled. Shipped-only filtering under-reports by 10-20%.

3. **Pulse source**: `amazon_spapi` only. Never use amazon_custom_combined_tax
   or amazon_tax_report for sales/nexus/liability — they are quarantined.

4. **Ads chunking**: All Ads API date ranges MUST be chunked to ≤30 days.
   `ads.mandatory_chunking = true`. Un-chunked 90-day requests fail silently.

5. **SP-API chunking**: All SP-API report requests chunked to ≤30 days.

6. **COGS**: From `sku_costs` table only. Never infer COGS.

7. **P&L semantics**: Finances API = "Amazon Payout" (NOT "net proceeds").
   Contribution = Payout − COGS − Ad Spend.

## After Any Sales/Ads Change

```bash
pytest tests/test_business_invariants.py
python -m src.main pulse-audit --date $(date -v-1d +%Y-%m-%d)
```

## Key Modules

| Module | Purpose |
|--------|---------|
| `src/rules.py` | Business rules (reads `config/business_rules.json`) |
| `src/sales_daily.py` | Daily sales aggregation (Amazon + Shopify) |
| `src/amazon_sp/reports.py` | SP-API report parsing (orders, inventory, SKU) |
| `src/amazon_ads/reports.py` | Ads Reporting v3 (campaigns, search terms) |
| `src/amazon_ads/actions_engine.py` | PPC recommendation engine |
| `src/pnl.py` | Contribution P&L estimator |
| `src/channels.py` | Channel taxonomy, quarantine policy |
| `src/inventory/velocity.py` | Unit velocity engine |
| `src/forecast/` | SKU demand forecast with calibration |

## Source Quarantine

`amazon_custom_combined_tax` and `amazon_tax_report` are quarantined.
They exist in the DB for audit only — never feed nexus or liability math.
See `src/channels.py:QUARANTINED_SOURCES`.
