# Registration Triage — CPA Research Aid
**Report ID:** bb6471cd
**Generated:** 2026-08-16T15:30:26Z
**States evaluated:** 51

> DISCLAIMER: This is a research and monitoring aid — NOT legal, tax, or CPA advice. It does NOT recommend registration. Postures reflect best-available interpretation of public guidance and may be wrong or outdated. The CPA must independently verify each state's position before advising the client.

## Methodology

This report triages states into discussion buckets for CPA review.
It does **not** recommend registration. Buckets are:

- **A_discuss**: Discuss with CPA — inventory nexus asserted or contested, and Shopify direct sales or entity tax flag present.
- **B_monitor**: Monitor — carve-out state, low Shopify exposure, under economic threshold.
- **C_economic_watch**: Economic watch — approaching or exceeding economic nexus threshold.
- **D_entity_tax**: Entity tax flag — franchise, B&O, CAT, or FTB obligation independent of sales tax.

**Posture classifications** (from `config/fba_nexus_posture.json`):
- **asserts**: Majority position — state treats FBA inventory as physical nexus
- **carve_out**: Marketplace facilitator provisions may shield FBA-only seller
- **contested**: Active litigation or conflicting guidance
- **unknown**: Insufficient authority to determine

**Data sources**: inventory_events (FBA presence), sales_by_state 
(trailing 12-month Shopify + Amazon), franchise_tax_flags (entity taxes), 
nexus_status (economic nexus engine output).

## Summary by Triage Bucket

### A_discuss — Discuss with CPA — inventory nexus asserted or contested, and Shopify direct sales or entity tax flag present.
*27 states*

| State | Posture | Conf. | Shopify 12m | Amazon 12m | Econ Status | Entity Tax | Registered |
|-------|---------|-------|-------------|------------|-------------|------------|------------|
| AL — Alabama | asserts | medium | $785 | $19,041 | under (0%) |  |  |
| CA — California | asserts | high | $10,840 | $183,663 | under (58%) | Yes |  |
| CO — Colorado | asserts | medium | $3,585 | $49,902 | under (5%) |  |  |
| CT — Connecticut | asserts | medium | $1,082 | $20,200 | under (33%) |  |  |
| FL — Florida | asserts | medium | $8,025 | $137,711 | under (11%) |  |  |
| GA — Georgia | asserts | medium | $2,743 | $48,938 | under (4%) |  |  |
| ID — Idaho | asserts | medium | $683 | $21,443 | under (31%) |  |  |
| IN — Indiana | asserts | medium | $1,891 | $33,484 | under (3%) |  |  |
| KS — Kansas | asserts | medium | $626 | $13,696 | under (20%) |  |  |
| KY — Kentucky | asserts | medium | $839 | $16,178 | under (24%) |  |  |
| LA — Louisiana | asserts | medium | $839 | $12,464 | under (20%) |  |  |
| MA — Massachusetts | asserts | medium | $3,415 | $36,311 | under (5%) |  |  |
| MN — Minnesota | asserts | medium | $1,504 | $32,835 | exceeded (34%) |  |  |
| MO — Missouri | asserts | medium | $1,677 | $31,405 | under (33%) |  |  |
| MS — Mississippi | asserts | medium | $175 | $8,080 | under (0%) |  |  |
| NC — North Carolina | asserts | medium | $2,459 | $54,180 | approaching (81%) |  |  |
| NE — Nebraska | asserts | medium | $818 | $10,685 | exceeded (18%) |  |  |
| NM — New Mexico | asserts | medium | $932 | $9,330 | under (1%) |  |  |
| OH — Ohio | asserts | high | $3,564 | $60,994 | exceeded (91%) | Yes |  |
| PA — Pennsylvania | contested | low | $5,462 | $62,393 | approaching (95%) |  |  |
| SC — South Carolina | asserts | medium | $1,697 | $28,302 | under (43%) |  |  |
| SD — South Dakota | asserts | medium | $209 | $4,006 | under (6%) |  |  |
| TN — Tennessee | asserts | medium | $1,748 | $43,848 | under (2%) | Yes |  |
| UT — Utah | asserts | medium | $1,197 | $30,137 | under (2%) |  |  |
| VA — Virginia | asserts | medium | $2,442 | $41,178 | under (4%) |  |  |
| WA — Washington | asserts | high | $2,226 | $46,289 | under (72%) | Yes |  |
| WI — Wisconsin | asserts | medium | $2,304 | $35,410 | under (52%) |  |  |

### D_entity_tax — Entity tax flag — franchise, B&O, CAT, or FTB obligation independent of sales tax.
*2 states*

| State | Posture | Conf. | Shopify 12m | Amazon 12m | Econ Status | Entity Tax | Registered |
|-------|---------|-------|-------------|------------|-------------|------------|------------|
| NV — Nevada | carve_out | medium | $845 | $23,198 | exceeded (36%) | Yes |  |
| TX — Texas | carve_out | medium | $6,283 | $143,391 | under (30%) | Yes |  |

### B_monitor — Monitor — carve-out state, low Shopify exposure, under economic threshold.
*22 states*

| State | Posture | Conf. | Shopify 12m | Amazon 12m | Econ Status | Entity Tax | Registered |
|-------|---------|-------|-------------|------------|-------------|------------|------------|
| AK — Alaska | unknown | low | $128 | $3,984 | under (0%) |  |  |
| AR — Arkansas | carve_out | medium | $1,147 | $9,145 | under (2%) |  |  |
| AZ — Arizona | carve_out | high | $2,473 | $53,997 | under (4%) |  |  |
| DC — District of Col | unknown | low | $227 | $980 | under (2%) |  |  |
| DE — Delaware | unknown | high | $308 | $5,655 | under (0%) |  |  |
| HI — Hawaii | unknown | low | $439 | $4,007 | exceeded (7%) |  | Yes |
| IA — Iowa | carve_out | medium | $1,048 | $17,320 | under (25%) |  |  |
| IL — Illinois | carve_out | high | $3,715 | $55,250 | under (4%) |  |  |
| MD — Maryland | asserts | high | $4,044 | $28,451 | exceeded (45%) |  | Yes |
| ME — Maine | unknown | low | $336 | $5,131 | under (0%) |  |  |
| MI — Michigan | asserts | medium | $2,675 | $57,412 | exceeded (86%) |  | Yes |
| MT — Montana | unknown | high | $585 | $6,742 | under (0%) |  |  |
| ND — North Dakota | carve_out | medium | $144 | $3,899 | under (0%) |  |  |
| NH — New Hampshire | unknown | high | $828 | $13,009 | under (0%) |  |  |
| NJ — New Jersey | asserts | high | $5,900 | $54,176 | exceeded (85%) |  | Yes |
| NY — New York | carve_out | medium | $10,656 | $88,249 | under (20%) |  |  |
| OK — Oklahoma | carve_out | medium | $576 | $20,066 | under (1%) |  | Yes |
| OR — Oregon | unknown | high | $1,182 | $23,059 | under (0%) |  |  |
| RI — Rhode Island | asserts | medium | $448 | $5,382 | exceeded (8%) |  | Yes |
| VT — Vermont | unknown | low | $355 | $2,011 | under (2%) |  |  |
| WV — West Virginia | unknown | low | $455 | $5,862 | exceeded (9%) |  | Yes |
| WY — Wyoming | unknown | low | $228 | $4,081 | under (0%) |  |  |

## State Detail (Bucket A + D)

### AL — Alabama

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Ala. Code § 40-23-68; Alabama DOR marketplace facilitator rules do not relieve seller of nexus from stored inventory.
**Inventory presence:** 2024-01-01 to 2026-08-15 (1,222 events)
**Shopify sales (12m):** $784.99
**Amazon sales (12m):** $19,040.81
**Economic nexus:** under (0%)
**Marketplace counts toward threshold:** No
**Notes:** Inventory in AL warehouses creates physical presence. Marketplace facilitator collection does not eliminate registration requirement.

### CA — California

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: high)
**Citation:** Cal. Rev. & Tax. Code § 6203(c); CDTFA Publication 156. Inventory stored in CA creates nexus regardless of marketplace facilitator collection.
**Inventory presence:** 2024-01-01 to 2026-08-16 (14,254 events)
**Shopify sales (12m):** $10,839.53
**Amazon sales (12m):** $183,662.94
**Economic nexus:** under (58%)
**Marketplace counts toward threshold:** Yes
**Entity tax flags:** franchise_tax
**Notes:** California clearly asserts that inventory stored in the state creates nexus. Also triggers $800 minimum LLC franchise tax under R&TC § 17941. | Entity tax: CRITICAL: California imposes an $800 minimum annual franchise tax on LLCs regist

### CO — Colorado

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Colo. Rev. Stat. § 39-26-102(3); Colorado DOR guidance on physical presence. Inventory storage = physical presence.
**Inventory presence:** 2024-01-01 to 2026-08-16 (3,692 events)
**Shopify sales (12m):** $3,584.93
**Amazon sales (12m):** $49,902.47
**Economic nexus:** under (5%)
**Marketplace counts toward threshold:** No
**Notes:** Colorado treats stored inventory as physical presence. Marketplace facilitator collection does not eliminate seller registration.

### CT — Connecticut

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Conn. Gen. Stat. § 12-407(a)(15); Connecticut DRS marketplace facilitator guidance.
**Inventory presence:** 2024-01-01 to 2026-08-15 (3,007 events)
**Shopify sales (12m):** $1,082.39
**Amazon sales (12m):** $20,199.90
**Economic nexus:** under (33%)
**Marketplace counts toward threshold:** Yes
**Notes:** Connecticut treats inventory storage as establishing nexus. Marketplace facilitator provisions do not relieve seller nexus from physical presence.

### FL — Florida

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Fla. Stat. § 212.06(2)(b); Florida DOR TAA 22A-013. Inventory stored in FL creates dealer status.
**Inventory presence:** 2024-01-01 to 2026-08-16 (9,274 events)
**Shopify sales (12m):** $8,025.15
**Amazon sales (12m):** $137,711.37
**Economic nexus:** under (11%)
**Marketplace counts toward threshold:** No
**Notes:** Florida treats inventory as establishing dealer nexus. Marketplace sales do not count toward seller's economic threshold, but physical presence from inventory is independent.

### GA — Georgia

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Ga. Code § 48-8-2(8)(M.1); Georgia DOR marketplace guidance. Inventory creates dealer status.
**Inventory presence:** 2024-01-01 to 2026-08-15 (3,577 events)
**Shopify sales (12m):** $2,742.65
**Amazon sales (12m):** $48,937.59
**Economic nexus:** under (4%)
**Marketplace counts toward threshold:** No
**Notes:** Georgia asserts that stored inventory creates nexus. Marketplace facilitator provisions apply to collection, not nexus elimination.

### ID — Idaho

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Idaho Code § 63-3611; Idaho State Tax Commission guidance on physical presence.
**Inventory presence:** 2024-01-01 to 2026-08-14 (1,536 events)
**Shopify sales (12m):** $683.36
**Amazon sales (12m):** $21,443.14
**Economic nexus:** under (31%)
**Marketplace counts toward threshold:** Yes
**Notes:** Idaho treats inventory storage as physical presence creating nexus.

### IN — Indiana

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Ind. Code § 6-2.5-2-1(c); Indiana DOR marketplace facilitator guidance.
**Inventory presence:** 2024-01-01 to 2026-08-16 (2,660 events)
**Shopify sales (12m):** $1,890.69
**Amazon sales (12m):** $33,484.20
**Economic nexus:** under (3%)
**Marketplace counts toward threshold:** No
**Notes:** Indiana treats inventory as physical presence. Marketplace facilitator collection does not relieve seller from registration obligation arising from physical nexus.

### KS — Kansas

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Kan. Stat. § 79-3702(h); Kansas DOR guidance on retailer doing business.
**Inventory presence:** 2024-01-01 to 2025-11-24 (16 events)
**Shopify sales (12m):** $625.66
**Amazon sales (12m):** $13,695.93
**Economic nexus:** under (20%)
**Marketplace counts toward threshold:** Yes
**Notes:** Kansas treats inventory storage as doing business in the state, creating nexus.

### KY — Kentucky

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Ky. Rev. Stat. § 139.340; Kentucky DOR marketplace facilitator guidance.
**Inventory presence:** 2025-08-04 to 2026-08-15 (508 events)
**Shopify sales (12m):** $839.42
**Amazon sales (12m):** $16,177.63
**Economic nexus:** under (24%)
**Marketplace counts toward threshold:** Yes
**Notes:** Kentucky treats stored inventory as physical presence. Recent FC openings increase exposure.

### LA — Louisiana

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** La. Rev. Stat. § 47:301(4)(m); Louisiana Sales Tax Commission guidance.
**Inventory presence:** 2024-09-01 to 2026-08-15 (1,342 events)
**Shopify sales (12m):** $838.92
**Amazon sales (12m):** $12,463.79
**Economic nexus:** under (20%)
**Marketplace counts toward threshold:** Yes
**Notes:** Louisiana treats inventory storage as dealer nexus. Complex local tax structure (parishes).

### MA — Massachusetts

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Mass. Gen. Laws ch. 64H, § 1; Massachusetts DOR Directive 17-1. Inventory creates physical presence.
**Inventory presence:** 2024-03-01 to 2026-08-16 (2,271 events)
**Shopify sales (12m):** $3,414.98
**Amazon sales (12m):** $36,310.53
**Economic nexus:** under (5%)
**Marketplace counts toward threshold:** No
**Notes:** Massachusetts treats inventory stored in state as physical presence creating vendor nexus.

### MN — Minnesota

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Minn. Stat. § 297A.66; Minnesota DOR Revenue Notice 19-02.
**Inventory presence:** 2024-01-01 to 2026-08-15 (1,498 events)
**Shopify sales (12m):** $1,503.97
**Amazon sales (12m):** $32,835.05
**Economic nexus:** exceeded (34%)
**Marketplace counts toward threshold:** Yes
**Notes:** Minnesota treats inventory as physical presence. Also has economic nexus from transaction count.

### MO — Missouri

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Mo. Rev. Stat. § 144.605; Missouri DOR guidance effective Jan 2023.
**Inventory presence:** 2024-01-01 to 2026-08-15 (3,218 events)
**Shopify sales (12m):** $1,676.84
**Amazon sales (12m):** $31,404.92
**Economic nexus:** under (33%)
**Marketplace counts toward threshold:** Yes
**Notes:** Missouri began requiring sales tax collection in 2023. Inventory storage creates physical presence.

### MS — Mississippi

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Miss. Code § 27-67-3; Mississippi DOR guidance on doing business.
**Inventory presence:** 2024-02-01 to 2026-08-15 (718 events)
**Shopify sales (12m):** $175.17
**Amazon sales (12m):** $8,079.60
**Economic nexus:** under (0%)
**Marketplace counts toward threshold:** No
**Notes:** Mississippi treats inventory storage as doing business in the state.

### NC — North Carolina

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** N.C. Gen. Stat. § 105-164.8(b); North Carolina DOR marketplace facilitator guidance.
**Inventory presence:** 2024-01-01 to 2026-08-16 (3,764 events)
**Shopify sales (12m):** $2,458.78
**Amazon sales (12m):** $54,180.36
**Economic nexus:** approaching (81%)
**Marketplace counts toward threshold:** Yes
**Notes:** North Carolina treats inventory as physical presence. Approaching economic threshold.

### NE — Nebraska

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Neb. Rev. Stat. § 77-2701.13; Nebraska DOR guidance on retailer engaged in business.
**Inventory presence:** 2024-01-01 to 2026-08-15 (873 events)
**Shopify sales (12m):** $818.40
**Amazon sales (12m):** $10,685.24
**Economic nexus:** exceeded (18%)
**Marketplace counts toward threshold:** Yes
**Notes:** Nebraska treats inventory as physical presence creating retailer nexus.

### NM — New Mexico

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** N.M. Stat. § 7-9-10; New Mexico TRD guidance on engaging in business.
**Inventory presence:** 2024-02-01 to 2026-08-15 (628 events)
**Shopify sales (12m):** $931.81
**Amazon sales (12m):** $9,329.99
**Economic nexus:** under (1%)
**Marketplace counts toward threshold:** No
**Notes:** New Mexico uses Gross Receipts Tax (not traditional sales tax). Inventory creates engaging-in-business nexus.

### OH — Ohio

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: high)
**Citation:** Ohio Rev. Code § 5741.01(H)(2); Ohio Department of Taxation Information Release ST 2019-02.
**Inventory presence:** 2024-01-01 to 2026-08-16 (7,962 events)
**Shopify sales (12m):** $3,563.82
**Amazon sales (12m):** $60,993.77
**Economic nexus:** exceeded (91%)
**Marketplace counts toward threshold:** Yes
**Entity tax flags:** franchise_tax
**Notes:** Ohio clearly asserts inventory creates nexus. Also has Commercial Activity Tax (CAT) for Ohio gross receipts >$150k. | Entity tax: Ohio Commercial Activity Tax (CAT) applies to businesses with Ohio gross receipt

### PA — Pennsylvania

**Triage bucket:** A_discuss
**FBA posture:** contested (confidence: low)
**Citation:** Online Merchants Guild v. Hassell (M.D. Pa., filed 2023). 72 P.S. § 7201; Pennsylvania DOR REV-717.
**Inventory presence:** 2024-02-01 to 2026-08-15 (1,754 events)
**Shopify sales (12m):** $5,462.39
**Amazon sales (12m):** $62,393.43
**Economic nexus:** approaching (95%)
**Marketplace counts toward threshold:** Yes
**Notes:** CONTESTED. Active litigation (Online Merchants Guild v. Hassell) challenges whether FBA inventory storage creates nexus for out-of-state sellers when Amazon is the marketplace facilitator. Pennsylvania asserts nexus; industry groups contest. CPA must independently evaluate.

### SC — South Carolina

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** S.C. Code § 12-36-70; South Carolina DOR Revenue Ruling 19-3.
**Inventory presence:** 2024-01-01 to 2026-08-15 (554 events)
**Shopify sales (12m):** $1,697.46
**Amazon sales (12m):** $28,302.39
**Economic nexus:** under (43%)
**Marketplace counts toward threshold:** Yes
**Notes:** South Carolina treats inventory as physical presence creating nexus.

### SD — South Dakota

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** S.D. Codified Laws § 10-45-1; South Dakota DOR guidance. Post-Wayfair nexus includes physical presence from inventory.
**Inventory presence:** 2024-03-01 to 2026-08-16 (634 events)
**Shopify sales (12m):** $209.04
**Amazon sales (12m):** $4,006.29
**Economic nexus:** under (6%)
**Marketplace counts toward threshold:** Yes
**Notes:** South Dakota treats inventory storage as physical presence.

### TN — Tennessee

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Tenn. Code § 67-6-102; Tennessee DOR Important Notice 19-18.
**Inventory presence:** 2024-02-01 to 2026-08-16 (4,101 events)
**Shopify sales (12m):** $1,747.68
**Amazon sales (12m):** $43,848.07
**Economic nexus:** under (2%)
**Marketplace counts toward threshold:** No
**Entity tax flags:** franchise_tax
**Notes:** Tennessee treats inventory as physical presence. Also has franchise & excise tax implications. | Entity tax: Tennessee franchise & excise tax may apply to entities doing business in TN. The

### UT — Utah

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Utah Code § 59-12-107(2); Utah State Tax Commission guidance.
**Inventory presence:** 2024-03-01 to 2026-08-16 (2,167 events)
**Shopify sales (12m):** $1,197.33
**Amazon sales (12m):** $30,137.00
**Economic nexus:** under (2%)
**Marketplace counts toward threshold:** No
**Notes:** Utah treats inventory storage as physical presence creating nexus.

### VA — Virginia

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Va. Code § 58.1-612; Virginia Tax marketplace facilitator guidance.
**Inventory presence:** 2024-01-01 to 2026-08-16 (3,785 events)
**Shopify sales (12m):** $2,441.60
**Amazon sales (12m):** $41,178.34
**Economic nexus:** under (4%)
**Marketplace counts toward threshold:** No
**Notes:** Virginia treats inventory as physical presence. Marketplace sales do NOT count toward seller's economic threshold.

### WA — Washington

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: high)
**Citation:** Wash. Rev. Code § 82.04.067; Washington DOR Special Notice. Inventory = substantial nexus.
**Inventory presence:** 2024-01-01 to 2026-08-16 (2,901 events)
**Shopify sales (12m):** $2,226.23
**Amazon sales (12m):** $46,288.92
**Economic nexus:** under (72%)
**Marketplace counts toward threshold:** Yes
**Entity tax flags:** franchise_tax
**Notes:** Washington clearly asserts inventory creates nexus. Also has B&O tax on gross receipts — separate from sales tax. Dual obligation. | Entity tax: Washington B&O (Business & Occupation) tax applies to gross receipts from busine

### WI — Wisconsin

**Triage bucket:** A_discuss
**FBA posture:** asserts (confidence: medium)
**Citation:** Wis. Stat. § 77.51(13g); Wisconsin DOR marketplace facilitator guidance.
**Inventory presence:** 2024-01-01 to 2026-08-15 (2,252 events)
**Shopify sales (12m):** $2,304.32
**Amazon sales (12m):** $35,410.29
**Economic nexus:** under (52%)
**Marketplace counts toward threshold:** Yes
**Notes:** Wisconsin treats inventory storage as physical presence.

### NV — Nevada

**Triage bucket:** D_entity_tax
**FBA posture:** carve_out (confidence: medium)
**Citation:** Nev. Rev. Stat. § 372A.200; Nevada Tax Commission marketplace facilitator guidance. Avalara: FBA sellers may be shielded.
**Inventory presence:** 2024-01-01 to 2026-08-16 (2,609 events)
**Shopify sales (12m):** $845.37
**Amazon sales (12m):** $23,197.74
**Economic nexus:** exceeded (36%)
**Marketplace counts toward threshold:** Yes
**Entity tax flags:** franchise_tax
**Notes:** Nevada marketplace facilitator provisions may shield FBA-only sellers. Also has Commerce Tax for gross revenue >$4M (unlikely for most small sellers). | Entity tax: Nevada Commerce Tax applies to businesses with Nevada gross revenue over $4M. Un

### TX — Texas

**Triage bucket:** D_entity_tax
**FBA posture:** carve_out (confidence: medium)
**Citation:** Tex. Tax Code § 151.0242; Texas Comptroller Rule 3.286. Marketplace facilitator provisions. However, franchise tax (Tex. Tax Code Ch. 171) still applies.
**Inventory presence:** 2024-01-01 to 2026-08-16 (12,245 events)
**Shopify sales (12m):** $6,283.28
**Amazon sales (12m):** $143,390.59
**Economic nexus:** under (30%)
**Marketplace counts toward threshold:** Yes
**Entity tax flags:** franchise_tax
**Notes:** Texas marketplace facilitator provisions may shield FBA-only sellers from SALES TAX registration. HOWEVER: Texas franchise tax applies independently — must file No Tax Due report + PIF annually if doing business in TX. Dual obligation. | Entity tax: IMPORTANT: Texas franchise tax applies to entities doing business in Texas. FBA 

---
> DISCLAIMER: This is a research and monitoring aid — NOT legal, tax, or CPA advice. It does NOT recommend registration. Postures reflect best-available interpretation of public guidance and may be wrong or outdated. The CPA must independently verify each state's position before advising the client.