# Business Rules — Non-Negotiable

These rules are codified in `config/business_rules.json` and enforced by
`src/rules.py`. Every parser, sync engine, and dashboard query MUST read
from `src/rules.py` — no duplicate literals.

After any sales/ads change run:
```
pytest tests/test_business_invariants.py && python -m src.main pulse-audit --date $(date -v-1d +%Y-%m-%d)
```

---

## Amazon Order Status

| Status             | Include? | Reason                                    |
|--------------------|----------|-------------------------------------------|
| Pending            | YES      | Matches Seller Central "ordered product sales" |
| Unshipped          | YES      | Order placed, not yet fulfilled           |
| PartiallyShipped   | YES      | Partially fulfilled                       |
| Shipped            | YES      | Fully fulfilled                           |
| Cancelled          | NO       | Not a real order                          |

**Key rule**: Seller Central counts ALL non-cancelled orders by `purchase-date`
in `America/Los_Angeles`. Our Pulse, sales_daily, nexus, and velocity data
must do the same. Filtering to "shipped only" under-reports by 10-20%.

## Amazon Timezone

All Amazon date boundaries use `America/Los_Angeles` (Pacific). The SP-API
`purchase-date` field is the canonical timestamp. Converting to a different
timezone will cause day-boundary mismatches vs Seller Central.

## Pulse / Daily Sales Source

The ONLY source for Amazon daily sales is `amazon_spapi`. Any other source
(amazon_custom_combined_tax, amazon_tax_report, settlement TSVs) is
quarantined and must NOT feed Pulse or nexus/liability calculations.

## Ads API Chunking

Amazon Ads Reporting v3 has a hard limit of 31 days per report request.
All date ranges MUST be chunked to ≤30 days (config: `ads.max_chunk_days`).
Chunking is mandatory — a single un-chunked 90-day request returns errors
or empty data silently.

The same 30-day chunking applies to SP-API order reports
(config: `spapi.max_chunk_days`).

SB/SD campaign-report poll timeouts are
`ads.campaign_report_timeout_sb_seconds` and
`ads.campaign_report_timeout_sd_seconds` (default 1800 each, matching SP).
SP keeps the Ads client default (1800s) and has no override. Search-term
reports use `ads.search_term_timeout_seconds` (5400).

## COGS & P&L

- COGS come from the `sku_costs` table only. Never infer or hallucinate COGS.
- Amazon Finances API output = **Amazon Payout** (charges - fees - refunds).
  This is NOT "net proceeds" — it excludes COGS and ad spend.
- **Contribution** = Amazon Payout − COGS − Ad Spend.
  This is the true per-unit/per-day profitability metric.
- Estimator defaults: referral 15%, FBA $3.50/unit. These are overridable
  via env vars or the sku_costs table.
