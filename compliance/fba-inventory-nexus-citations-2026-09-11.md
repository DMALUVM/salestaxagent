# FBA inventory nexus — Tess citation packets

**Source:** Tess · Tax & Compliance (Dave’s SoT for tax)  
**Packet date:** 2026-09-11  
**Use:** Sales-tax registration *plan* only. Citations support a recommendation. **Do not auto-register.**  
**Disclaimer:** Monitoring and research aid — not legal, tax, or CPA advice. Confirm with a CPA before registering or filing.

These packets are the source of truth for FBA *physical* nexus on the registration plan. Avalara / Grant Thornton / STI seed in `config/fba_nexus_posture.json` is a secondary research aid only and must not override Tess.

Machine-readable twin: `config/fba_inventory_nexus_citations.json`.

Documentation status:

- **documented** — statute / agency language Tess judged strong enough to drive `register_now` (asserts) or to *block* silent `register_now` (carve-out).
- **partial** — warehouse / storage language exists, but FBA is not named (or the position is fact-specific). Never quiet `register_now`.
- **unknown** — no Tess packet. Inventory is flagged for statute review.

---

## Documented seller-favorable / carve-out

FBA-only inventory at a marketplace facilitator does **not** become `register_now`. Action: `review_contested`.

### Illinois — high, documented

**Posture:** carve-out (MF-only inventory at the facilitator’s location).  
**Own / mixed channel:** physical presence **does** attach if the seller (not only Amazon) stores or controls inventory in IL.

Prefer these cites:

- 35 ILCS 105/2(1)
- 86 Ill. Adm. Code 131.105
- PIO-125
- IDOR marketplace-facilitator FAQ

**Drop:** 35 ILCS 105/2(1.1) (click-through nexus). That is not the FBA-inventory cite.

Short cite: `35 ILCS 105/2(1); 86 Ill. Adm. Code 131.105; PIO-125; IDOR MF FAQ`

### New York — high, documented

**Posture:** carve-out / fulfillment safe harbor for marketplace fulfillment.

Cites:

- N.Y. Tax Law § 1101(b)(8)(v)
- N.Y. Tax Law § 1101(b)(18)
- TSB-A-24(45)S (10/10/2024)

20 NYCRR 526.10 is the **general vendor definition only**. Do not treat it as the FBA fulfillment cite.

Short cite: `N.Y. Tax Law § 1101(b)(8)(v), (b)(18); TSB-A-24(45)S (10/10/2024)`

---

## Documented asserts

Inventory / storage language is strong enough to support `register_now` when FBA inventory is present and the state is not already registered. Show citation + Tess confidence. Still not legal advice; still no auto-register.

### Idaho — high, documented

- Idaho Code § 63-3611(3)(a) — warehouse / stock of goods
- Idaho State Tax Commission online-seller guide

Short cite: `Idaho Code § 63-3611(3)(a); ISTC online-seller guide`

### Louisiana — high, documented

- LDR Remote Sellers FAQ — physical presence includes storage in a third-party facility
- La. R.S. 47:301(4)(h)

Short cite: `La. R.S. 47:301(4)(h); LDR Remote Sellers FAQ`

### New Mexico — high, documented

- TRD *Determining Nexus* — “having property stored in New Mexico”
- NMSA § 7-9-3.3

Short cite: `NMSA § 7-9-3.3; TRD Determining Nexus`

---

## Partial — inventory-flagged / needs statute review

Do **not** quiet `register_now`. Reason must say **partial — FBA not named; CPA confirm** (AZ: fact-specific).  
Action: `needs_statute_review`, except Arizona (`review_contested`).

### Arizona — medium, partial

ADOR FAQ: inventory at the seller’s control vs 3PL with no control (“likely not”). Contested / fact-specific.

Short cite: `ADOR FAQ (inventory-at-control vs 3PL no-control)`

### Missouri — medium, partial

12 CSR 10-114.100 (owns TPP / warehouse). No FBA-named publication.

Short cite: `12 CSR 10-114.100`

### Alabama — medium, partial

Ala. Code § 40-23-68 (warehouse / storage). FBA not named.

Short cite: `Ala. Code § 40-23-68`

### Mississippi — medium, partial

Miss. Code § 27-67-3(j) (owning personal property used by another). FBA not named.

Short cite: `Miss. Code § 27-67-3(j)`

---

## States with no Tess packet

`has_physical_nexus` from FBA FC lists may still be medium. Registration-plan action for inventory + no packet is `needs_statute_review` (unknown), never silent `register_now` from `unknown_default_true` or Avalara seed.
