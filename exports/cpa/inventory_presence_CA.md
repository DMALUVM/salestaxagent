# FBA Inventory Presence by State
**Report ID:** 57ae71eb
**Generated:** 2026-08-16T14:56:11Z
**Data as-of:** 2026-08-16
**States with evidence:** 1

> DISCLAIMER: This is a monitoring/research aid assembled from Amazon fulfillment data. It is NOT legal, tax, or CPA advice. Rules change. Marketplace facilitator collection (Amazon) does not eliminate registration, franchise, or physical-nexus obligations in all states. Verify on each state's official DOR site before acting.

## Methodology

**How presence is detected:**
State presence is evidenced when ANY of:
1. An inventory event record exists with that state's FC code mapped to the state
   (via the FC → state mapping in config/fc_codes.json).
2. Ship-from state data from Amazon Custom Combined Tax or SP-API Inventory Ledger
   reports indicates fulfillment activity originating from that state.
3. An explicit physical nexus flag is set from the analysis engine using the same rules.

**Sources included:**
- Amazon SP-API Inventory Ledger Detail (GET_LEDGER_DETAIL_VIEW_DATA)
- Amazon Custom Combined Tax CSV (ship_from_state aggregates)
- FC-to-state mapping (322 fulfillment center codes)

**What this report does NOT claim:**
- Economic nexus or tax liability from ship-to sales alone
- Continuous 365-day warehouse storage (reports prove activity in period, not
  a literal stock certificate)
- Any legal conclusion — CPA must independently verify each state's position

**Date grain:**
Presence dates are at daily or monthly grain depending on source. Consecutive
months are compressed into From–To ranges. Gaps of 1+ months are listed as
separate ranges.

## Executive Summary

| State | First Evidence | Last Evidence | Events | FCs | Sources | Nexus Flag | Confidence |
|-------|---------------|---------------|--------|-----|---------|------------|------------|
| CA | 2024-01-01 | 2026-08-16 | 8,820 | 31 | 2 | Yes | high |

## State Detail

### CA — California
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 8,820
**Fulfillment centers:** BFL1, BFL2, FAT1, LAX9, LGB3, LGB7, LGB8, OAK4, ONT2, ONT6, ONT8, OXR1, PSP1, PSP3, SAN3 (+16 more)
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SBD6/B0F4992FTZ/2026-08-14; SBD6/B0CLHSC2WC/2026-08-13; PSP3/B0CLHSC2WC/2026-08-13

## Data Sources (Ingestion Log)

| Filename | Type | Rows | Date |
|----------|------|------|------|
| spapi_inventory_2025-08-01_2026-08-14 | amazon_inventory | 130,073 | 2026-08-14 |
| spapi_inventory_2026-08-08_2026-08-15 | amazon_inventory | 1,903 | 2026-08-15 |
| spapi_inventory_2026-08-09_2026-08-16 | amazon_inventory | 1,947 | 2026-08-16 |

---
> DISCLAIMER: This is a monitoring/research aid assembled from Amazon fulfillment data. It is NOT legal, tax, or CPA advice. Rules change. Marketplace facilitator collection (Amazon) does not eliminate registration, franchise, or physical-nexus obligations in all states. Verify on each state's official DOR site before acting.