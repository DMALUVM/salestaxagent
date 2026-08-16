# FBA Inventory Presence by State
**Report ID:** 56e62cfe
**Generated:** 2026-08-16T15:19:32Z
**Data as-of:** 2026-08-16
**States with evidence:** 42

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

## Validation Report
⚠ **WARNINGS present** — review before relying on this report.

- ✅ **A — Coverage**: 42 states, 129,125 events, dates 2024-01-01 to 2026-08-16
- ⚠️ **B — Consistency vs nexus_status**: IL: 5565 events but physical_nexus=false; AR: 207 events but physical_nexus=false; NV: 2609 events but physical_nexus=false; NY: 4314 events but physical_nexus=false; AZ: 4021 events but physical_nexus=false
- ⚠️ **C — Date integrity**: 1994 events with null state_code
- ✅ **D — Dedup / range compression**: Consecutive months compressed into ranges; duplicates collapsed
- ⚠️ **E — Confidence**: CONTESTED: PA; FBA carve-out states (nexus not asserted): IL, AR, NV, NY, AZ, OK, IA, DE, OR, ND

## Executive Summary

| State | First Evidence | Last Evidence | Events | FCs | Sources | Nexus Flag | Confidence |
|-------|---------------|---------------|--------|-----|---------|------------|------------|
| AL | 2024-01-01 | 2026-08-15 | 1,222 | 2 | 2 | Yes | medium |
| AR | 2024-01-01 | 2026-07-30 | 207 | 2 | 2 | No | carve-out |
| AZ | 2024-01-01 | 2026-08-16 | 4,021 | 13 | 2 | No | carve-out |
| CA | 2024-01-01 | 2026-08-16 | 14,254 | 36 | 2 | Yes | high |
| CO | 2024-01-01 | 2026-08-16 | 3,692 | 7 | 2 | Yes | medium |
| CT | 2024-01-01 | 2026-08-15 | 3,007 | 4 | 2 | Yes | medium |
| DE | 2024-02-01 | 2025-03-01 | 14 | 1 | 1 | No | carve-out |
| FL | 2024-01-01 | 2026-08-16 | 9,274 | 20 | 2 | Yes | high |
| GA | 2024-01-01 | 2026-08-15 | 3,577 | 10 | 2 | Yes | medium |
| IA | 2024-01-01 | 2026-08-15 | 1,587 | 3 | 2 | No | carve-out |
| ID | 2024-01-01 | 2026-08-14 | 1,536 | 3 | 2 | Yes | medium |
| IL | 2024-01-01 | 2026-08-16 | 5,565 | 12 | 2 | No | carve-out |
| IN | 2024-01-01 | 2026-08-16 | 2,660 | 8 | 2 | Yes | medium |
| KS | 2024-01-01 | 2025-11-24 | 16 | 2 | 2 | Yes | medium |
| KY | 2025-08-04 | 2026-08-15 | 508 | 9 | 1 | Yes | medium |
| LA | 2024-09-01 | 2026-08-15 | 1,342 | 3 | 2 | Yes | medium |
| MA | 2024-03-01 | 2026-08-16 | 2,271 | 5 | 2 | Yes | medium |
| MD | 2024-01-01 | 2026-08-16 | 2,736 | 5 | 2 | Yes | high |
| MI | 2024-01-01 | 2026-08-15 | 4,421 | 7 | 2 | Yes | medium |
| MN | 2024-01-01 | 2026-08-15 | 1,498 | 3 | 2 | Yes | medium |
| MO | 2024-01-01 | 2026-08-15 | 3,218 | 6 | 2 | Yes | medium |
| MS | 2024-02-01 | 2026-08-15 | 718 | 2 | 2 | Yes | medium |
| NC | 2024-01-01 | 2026-08-16 | 3,764 | 9 | 2 | Yes | medium |
| ND | 2025-08-09 | 2026-04-27 | 14 | 1 | 1 | No | carve-out |
| NE | 2024-01-01 | 2026-08-15 | 873 | 3 | 2 | Yes | medium |
| NJ | 2024-01-01 | 2026-08-16 | 6,367 | 15 | 2 | Yes | high |
| NM | 2024-02-01 | 2026-08-15 | 628 | 3 | 2 | Yes | medium |
| NV | 2024-01-01 | 2026-08-16 | 2,609 | 7 | 2 | No | carve-out |
| NY | 2024-01-01 | 2026-08-16 | 4,314 | 10 | 2 | No | carve-out |
| OH | 2024-01-01 | 2026-08-16 | 7,962 | 14 | 2 | Yes | high |
| OK | 2024-01-01 | 2026-08-16 | 1,883 | 4 | 2 | Yes | carve-out |
| OR | 2024-02-01 | 2026-08-15 | 2,124 | 5 | 2 | No | carve-out |
| PA | 2024-02-01 | 2026-08-15 | 1,754 | 9 | 2 | Yes | ⚠ CONTESTED |
| RI | 2024-11-01 | 2026-08-15 | 850 | 2 | 2 | Yes | medium |
| SC | 2024-01-01 | 2026-08-15 | 554 | 3 | 2 | Yes | medium |
| SD | 2024-03-01 | 2026-08-16 | 634 | 2 | 2 | Yes | medium |
| TN | 2024-02-01 | 2026-08-16 | 4,101 | 11 | 2 | Yes | medium |
| TX | 2024-01-01 | 2026-08-16 | 12,245 | 29 | 2 | Yes | high |
| UT | 2024-03-01 | 2026-08-16 | 2,167 | 5 | 2 | Yes | medium |
| VA | 2024-01-01 | 2026-08-16 | 3,785 | 9 | 2 | Yes | medium |
| WA | 2024-01-01 | 2026-08-16 | 2,901 | 8 | 2 | Yes | high |
| WI | 2024-01-01 | 2026-08-15 | 2,252 | 4 | 2 | Yes | medium |

## State Detail

### AL — Alabama
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,222
**Fulfillment centers:** BHM1, TAX-RPT-AL
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BHM1/B0CLHVCPL5/2026-08-07; BHM1/B0CLHVCPL5/2026-08-07; BHM1/B0CLHV3V5C/2026-08-06

### AR — Arkansas
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (3 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-02
- 2026-07

**Events:** 207
**Fulfillment centers:** LIT1, TAX-RPT-AR
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** LIT1/B0CLHVCPL5/2026-07-30; LIT1/B0CLHVCPL5/2026-02-22; LIT1/B0CLHVLG2F/2026-02-22

### AZ — Arizona
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 4,021
**Fulfillment centers:** GYR1, GYR2, GYR3, PGA1, PHX3, PHX5, PHX6, SAZ1, SAZ2, SAZ3, TAX-RPT-AZ, TUS1, TUS2
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** GYR1/B0CLHVCPL5/2026-08-07; PHX3/B0CLHTKY3V/2026-08-07; GYR1/B0CLHTKY3V/2026-08-07

### CA — California
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 14,254
**Fulfillment centers:** BFL1, BFL2, FAT1, LAX9, LGB3, LGB7, LGB8, MCC1, OAK4, ONT2, ONT6, ONT8, OXR1, PSP1, PSP3 (+21 more)
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SBD6/B0F4992FTZ/2026-08-14; SBD6/B0CLHSC2WC/2026-08-13; PSP3/B0CLHSC2WC/2026-08-13

### CO — Colorado
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,692
**Fulfillment centers:** BJC1, DEN3, DEN4, DEN9, SCO1, SCO2, TAX-RPT-CO
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** DEN4/B0CLHVLG2F/2026-08-13; DEN3/B0CLHVLG2F/2026-08-13; DEN3/B0CLHVCPL5/2026-08-07

### CT — Connecticut
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,007
**Fulfillment centers:** BDL2, BDL3, BDL4, TAX-RPT-CT
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BDL4/B0CLHVLG2F/2026-08-13; BDL4/B0CXJLR2Y3/2026-08-07; BDL3/B0CLHVCPL5/2026-08-07

### DE — Delaware
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (1 range):
- 2024-02 to 2025-03

**Events:** 14
**Fulfillment centers:** TAX-RPT-DE
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv

### FL — Florida
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 9,274
**Fulfillment centers:** DAB2, HIA1, JAX2, JAX7, MCO1, MIA1, PBI3, SFL1, SFL2, SFL3, SFL4, SFL6, SFL7, SFL8, SJA1 (+5 more)
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** TPA4/B0F4DN5951/2026-08-07; TPA4/B0CLHVCPL5/2026-08-07; MIA1/B0CLHVCPL5/2026-08-07

### GA — Georgia
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,577
**Fulfillment centers:** AGS1, AGS2, ATL2, ATL7, CSG1, RYY2, SAV4, SGA1, SGA2, TAX-RPT-GA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** ATL2/B0CLHVLG2F/2026-08-13; SAV4/B0F4992FTZ/2026-08-07; SAV4/B0CLHVCPL5/2026-08-07

### IA — Iowa
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,587
**Fulfillment centers:** DSM5, SIA2, TAX-RPT-IA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** DSM5/B0CLHVCPL5/2026-08-07; SIA2/B0CLHVCPL5/2026-08-06; DSM5/B0CLHVLG2F/2026-08-06

### ID — Idaho
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,536
**Fulfillment centers:** BOI2, SID1, TAX-RPT-ID
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BOI2/B0CLHVCPL5/2026-08-07; SID1/B0CLHVCPL5/2026-08-07; SID1/B0CLHVCPL5/2026-08-06

### IL — Illinois
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 5,565
**Fulfillment centers:** IGQ1, MDW2, MDW4, MDW7, MLI1, ORD5, RFD2, SIL1, SIL2, SIL3, SIL4, TAX-RPT-IL
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** MDW7/B0CLHTKY3V/2026-08-07; IGQ1/B0CLHTKY3V/2026-08-07; MLI1/B0CLHTKY3V/2026-08-07

### IN — Indiana
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,660
**Fulfillment centers:** FWA4, FWA6, IND1, IND8, IND9, SBN1, SIN9, TAX-RPT-IN
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** IND1/B0CLHYY3BB/2026-08-07; FWA6/B0CLHYY3BB/2026-08-07; FWA6/B0CLHVCPL5/2026-08-06

### KS — Kansas
**Presence periods** (3 ranges):
- 2024-01
- 2024-03 to 2025-03
- 2025-11

**Events:** 16
**Fulfillment centers:** MCI7, TAX-RPT-KS
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** MCI7/B0CLHV3V5C/2025-11-24; MCI7/B0CLHV3V5C/2025-11-18

### KY — Kentucky
**Presence periods** (1 range):
- 2025-08 to 2026-08

**Events:** 508
**Fulfillment centers:** BKY1, CVG2, LEX1, LEX2, SDF1, SDF6, SDF8, SDF9, SKY2
**Sources:** spapi_inventory_ledger
**Sample references:** SDF8/B0CLHVLG2F/2026-08-06; SDF1/B0CLHVLG2F/2026-08-03; SKY2/B0CLHVLG2F/2026-08-03

### LA — Louisiana
**Presence periods** (2 ranges):
- 2024-09 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,342
**Fulfillment centers:** BTR1, SHV1, TAX-RPT-LA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BTR1/B0CLHVCPL5/2026-08-07; SHV1/B0CLHVCPL5/2026-08-07; BTR1/B0CLHV3V5C/2026-08-07

### MA — Massachusetts
**Presence periods** (2 ranges):
- 2024-03 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,271
**Fulfillment centers:** BOS3, ORH3, SMA1, SMA2, TAX-RPT-MA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BOS3/B0CLHTKY3V/2026-08-09; ORH3/B0CXJLR2Y3/2026-08-07; ORH3/B0CLHVCPL5/2026-08-07

### MD — Maryland
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,736
**Fulfillment centers:** BWI2, HGR5, MTN1, SMD1, TAX-RPT-MD
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** BWI2/B0CLHTKY3V/2026-08-09; MTN1/B0F4DN5951/2026-08-06; MTN1/B0CLHVCPL5/2026-08-06

### MI — Michigan
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 4,421
**Fulfillment centers:** DET3, DET6, DTW1, GRR1, LAN2, SMI1, TAX-RPT-MI
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** DTW1/B0CLHSGG49/2026-08-13; DTW1/B0CLHVCPL5/2026-08-07; SMI1/B0CLHVLG2F/2026-08-07

### MN — Minnesota
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,498
**Fulfillment centers:** MSP1, SMN1, TAX-RPT-MN
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** MSP1/B0CLHVLG2F/2026-08-07; MSP1/B0CLHVCPL5/2026-08-06; MSP1/B0CLHTKY3V/2026-08-05

### MO — Missouri
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,218
**Fulfillment centers:** MKC6, SMO1, SMO2, STL3, STL8, TAX-RPT-MO
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** STL8/B0CLHVCPL5/2026-08-07; MKC6/B0CLHVCPL5/2026-08-07; STL8/B0CLHTKY3V/2026-08-07

### MS — Mississippi
**Presence periods** (2 ranges):
- 2024-02 to 2025-03
- 2025-08 to 2026-08

**Events:** 718
**Fulfillment centers:** JAN1, TAX-RPT-MS
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** JAN1/B0CV6TDHWS/2026-08-07; JAN1/B0CV6TDHWS/2026-08-07; JAN1/B0CLHVLG2F/2026-08-07

### NC — North Carolina
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,764
**Fulfillment centers:** CLT2, CLT4, RDU1, RDU2, RDU4, SNC2, SNC3, SNC6, TAX-RPT-NC
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** CLT4/B0CLHVLG2F/2026-08-13; CLT4/B0CLHTKY3V/2026-08-09; SNC3/B0CLHTKY3V/2026-08-07

### ND — North Dakota
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2025-08 to 2026-01
- 2026-04

**Events:** 14
**Fulfillment centers:** FAR1
**Sources:** spapi_inventory_ledger
**Sample references:** FAR1/B0CLHTKY3V/2026-04-27; FAR1/B0CLHTKY3V/2026-04-25; FAR1/B0CLHVCPL5/2026-01-27

### NE — Nebraska
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 873
**Fulfillment centers:** OMA2, SNE1, TAX-RPT-NE
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** OMA2/B0CLHVLG2F/2026-08-05; OMA2/B0CLHVLG2F/2026-08-05; SNE1/B0CLHVLG2F/2026-08-05

### NJ — New Jersey
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 6,367
**Fulfillment centers:** ABE2, ABE4, ABE8, ACY1, EWR4, EWR7, EWR9, LGA9, SNJ1, SNJ2, SNJ3, TAX-RPT-NJ, TEB3, TEB9, WBW2
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** EWR4/B0CLHVLG2F/2026-08-13; EWR4/B0F4DN5951/2026-08-07; LGA9/B0CLHVCPL5/2026-08-07

### NM — New Mexico
**Presence periods** (2 ranges):
- 2024-02 to 2025-03
- 2025-08 to 2026-08

**Events:** 628
**Fulfillment centers:** ABQ1, ABQ2, TAX-RPT-NM
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** ABQ2/B0CLF5B27Y/2026-05-21; ABQ1/B0CLHVLG2F/2026-05-02; ABQ1/B0CLHTKY3V/2026-04-30

### NV — Nevada
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,609
**Fulfillment centers:** LAS1, LAS2, LAS7, SNV1, TAX-RPT-NV, VGT1, VGT2
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** LAS7/B0CLHTKY3V/2026-08-07; LAS1/B0CLHTKY3V/2026-08-07; VGT1/B0CLHV3V5C/2026-08-07

### NY — New York
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 4,314
**Fulfillment centers:** JFK8, JHW1, ROC1, SNY1, SNY2, SNY5, SWF2, SWF4, SYR1, TAX-RPT-NY
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SWF2/B0CLHVCPL5/2026-08-14; SWF2/B0CLHVCPL5/2026-08-14; SWF2/B0CLHVCPL5/2026-08-14

### OH — Ohio
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 7,962
**Fulfillment centers:** AKC1, CLE2, CLE3, CMH1, CMH4, CMH7, LUK2, MQJ1, PCW1, SOH1, SOH2, SOH3, TAX-RPT-OH, TOL3
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** CLE3/B0CLHVLG2F/2026-08-13; CLE2/B0CLHVLG2F/2026-08-13; CMH4/B0CLHTKY3V/2026-08-09

### OK — Oklahoma
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,883
**Fulfillment centers:** OKC1, SOK1, TAX-RPT-OK, TUL2
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** OKC1/B0CLHVCPL5/2026-08-07; TUL2/B0CLHV3V5C/2026-08-07; OKC1/B0CLHYY3BB/2026-08-07

### OR — Oregon
ℹ **FBA carve-out** — This state has a marketplace-facilitator FBA carve-out. Physical nexus from FBA inventory alone may not apply.

**Presence periods** (2 ranges):
- 2024-02 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,124
**Fulfillment centers:** PDX7, PDX8, PDX9, SOR3, TAX-RPT-OR
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** PDX9/B0CLHVCPL5/2026-08-07; PDX9/B0CLHVCPL5/2026-08-07; PDX9/B0CLHTKY3V/2026-08-07

### PA — Pennsylvania
⚠ **CONTESTED** — FBA nexus position is contested in this state. Verify with counsel before asserting physical nexus.

**Presence periods** (2 ranges):
- 2024-02 to 2025-03
- 2025-08 to 2026-08

**Events:** 1,754
**Fulfillment centers:** AVP1, LBE1, PHL1, PHL7, RDG1, SPA1, SPA4, SPA5, TAX-RPT-PA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** AVP1/B0F4DN5951/2026-08-07; SPA4/B0CLHVCPL5/2026-08-07; SPA4/B0CLHVLG2F/2026-08-07

### RI — Rhode Island
**Presence periods** (2 ranges):
- 2024-11 to 2025-03
- 2025-08 to 2026-08

**Events:** 850
**Fulfillment centers:** PVD2, TAX-RPT-RI
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** PVD2/B0CLF5FFTC/2026-08-13; PVD2/B0CLHVCPL5/2026-08-07; PVD2/B0CLHVCPL5/2026-08-06

### SC — South Carolina
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 554
**Fulfillment centers:** CAE1, SSC4, TAX-RPT-SC
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SSC4/B0CLHTKY3V/2026-08-07; SSC4/B0CLHTKY3V/2026-08-05; SSC4/B0CLHVLG2F/2026-08-05

### SD — South Dakota
**Presence periods** (2 ranges):
- 2024-03 to 2025-03
- 2025-08 to 2026-08

**Events:** 634
**Fulfillment centers:** FSD1, TAX-RPT-SD
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** FSD1/B0CLHV3V5C/2026-08-07; FSD1/B0CLHV3V5C/2026-08-07; FSD1/B0CLHVCPL5/2026-08-06

### TN — Tennessee
**Presence periods** (2 ranges):
- 2024-02 to 2025-03
- 2025-08 to 2026-08

**Events:** 4,101
**Fulfillment centers:** BNA3, BNA6, CHA1, MEM1, MEM3, MEM4, MQY1, STN1, TAX-RPT-TN, TEN1, TYS1
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** TYS1/B0CLHVCPL5/2026-08-07; TYS1/B0CLHVCPL5/2026-08-07; STN1/B0CLHVLG2F/2026-08-07

### TX — Texas
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 12,245
**Fulfillment centers:** AFW1, AUS2, AUS3, DAL2, DAL3, DFW7, ELP1, FTW1, FTW6, HOU2, HOU3, HOU6, IAH1, IAH3, KRB2 (+14 more)
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** FTW6/B0CLHVLG2F/2026-08-13; ELP1/B0CLHVLG2F/2026-08-13; DFW7/B0CLHVLG2F/2026-08-13

### UT — Utah
**Presence periods** (2 ranges):
- 2024-03 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,167
**Fulfillment centers:** SLC1, SLC2, SUT1, SUT2, TAX-RPT-UT
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SLC1/B0CLHSC2WC/2026-08-13; SLC1/B0CV6TDHWS/2026-08-07; SUT1/B0CLHVCPL5/2026-08-07

### VA — Virginia
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 3,785
**Fulfillment centers:** DCA1, DCA6, ORF2, ORF3, ORF4, RIC2, RIC4, SVA2, TAX-RPT-VA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** ORF3/B0CLF5FFTC/2026-08-13; ORF3/B0CLHTKY3V/2026-08-07; DCA1/B0CLHTKY3V/2026-08-07

### WA — Washington
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,901
**Fulfillment centers:** BFI4, GEG1, GEG2, PAE2, SWA1, SWA2, SWA4, TAX-RPT-WA
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** PAE2/B0CLHSC2WC/2026-08-13; GEG1/B0F4DMF2CJ/2026-08-07; BFI4/B0CLHVCPL5/2026-08-07

### WI — Wisconsin
**Presence periods** (2 ranges):
- 2024-01 to 2025-03
- 2025-08 to 2026-08

**Events:** 2,252
**Fulfillment centers:** MKE1, MKE2, SWI1, TAX-RPT-WI
**Sources:** 2024Jan1-2026Aug10_CustomCombinedTax.csv, spapi_inventory_ledger
**Sample references:** SWI1/B0CLHVCPL5/2026-08-07; MKE1/B0CLHTKY3V/2026-08-07; MKE1/B0CLF5B27Y/2026-08-07

## Data Sources (Ingestion Log)

| Filename | Type | Rows | Date |
|----------|------|------|------|
| spapi_inventory_2025-08-01_2026-08-14 | amazon_inventory | 130,073 | 2026-08-14 |
| spapi_inventory_2026-08-08_2026-08-15 | amazon_inventory | 1,903 | 2026-08-15 |
| spapi_inventory_2026-08-09_2026-08-16 | amazon_inventory | 1,947 | 2026-08-16 |

---
> DISCLAIMER: This is a monitoring/research aid assembled from Amazon fulfillment data. It is NOT legal, tax, or CPA advice. Rules change. Marketplace facilitator collection (Amazon) does not eliminate registration, franchise, or physical-nexus obligations in all states. Verify on each state's official DOR site before acting.