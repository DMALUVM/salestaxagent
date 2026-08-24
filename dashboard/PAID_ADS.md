# Paid Ads (Shopify) — Tallowbourn ads Intel

`/paid-ads` is the Shopify storefront ads desk. **Amazon PPC stays on `/ppc`.**

Primary path: **upload the four CSV types**. No OAuth. No demo data.
Range 7/14/30/90/365/all is relative to the **max date in the files**, not today.

| Source | File | Warehouse |
|---|---|---|
| Google Ads Daily (Campaign × Day, typed columns or Cost/Impr./Clicks/Conv.) | `paid_campaign_daily` `platform=google` | Upsert `platform\|date\|campaign_name` |
| Meta Ads Manager campaign export | `paid_campaign_daily` `platform=meta` | Skip $0 **and** 0-impression days. Never map CPC / cost-per-purchase as spend or revenue. |
| GSC `Queries.csv` + `Pages.csv` + `Chart.csv` (or a zip of those) | `paid_search_query_daily` | Queries/Pages are snapshots (`date=''`) and replace other empty-date rows of that kind only. Chart is daily. Do not invent Δ position from Queries.csv. |
| GA4 Explore | `paid_ga_daily` | Skip `#` comments and Grand total. Do not treat Total revenue as ads conversion value. Cross-network ≈ PMax. |

HTTP: `POST /api/paid-ads/csv` (multipart files or JSON `{ files: [{ name, content }] }`).
Read: `GET /api/paid-ads/intel?range=7&filter=all`.

Intel cards (max 12, ranked by $ at stake) are 7-day tests with a keep/kill metric.
Never move Meta/PMax onto Brand Search. Win/lose tables require spend ≥ $1.

Copy for Grok = keep/kill prompt + numbered stack + JSON snapshot.

Migration: `supabase/migration_paid_intel.sql` (additive, no DROP, no RLS).

---

# Ads Ops window feed (still supported)

Structured JSON may still be upserted into `paid_ads_snapshots` /
`paid_ads_campaigns_window` via `POST /api/paid-ads/ingest`. That path is
**not** a live scrape. See git history for the payload shape. The page
now reads the daily warehouse first.
