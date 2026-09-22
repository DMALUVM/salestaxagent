# Paid Ads (Shopify) — Tallowbourn ads Intel

`/paid-ads` is the Shopify storefront ads desk. **Amazon PPC stays on `/ppc`.**

Primary path: **official API tables** for Google Ads, GA4, and Search Console.
Meta stays on CSV until `meta_ads_daily` has rows. CSV upload remains a fallback
(`POST /api/paid-ads/csv`). No demo data.
Range 7/14/30/90/365/all is relative to the **max metric_date / date in the preferred source**, not today.

| Source | Live read | Fallback |
|---|---|---|
| Google Ads | `google_ads_daily` (`metric_date`, `conversion_value` → intel `date` / `conv_value`) | `paid_campaign_daily` `platform=google` (CSV) |
| Meta Ads | `meta_ads_daily` when it has rows | `paid_campaign_daily` `platform=meta` (CSV upload) |
| Search Console | `gsc_query_daily` + `gsc_page_daily` (dated; CTR 0–1 → 0–100); `gsc_dim_daily` `search_appearance` | `paid_search_query_daily` (CSV) |
| GA4 | `ga4_landing_daily` (`purchase` → `key_events`; no invented channel/revenue) | `paid_ga_daily` (CSV Explore) |

HTTP: `POST /api/paid-ads/csv` (multipart files or JSON `{ files: [{ name, content }] }`).
Read: `GET /api/paid-ads/intel?range=7&filter=all`.
Track: `POST /api/paid-ads/decision` `{ card_id, as_of, status: applied|dismissed|open }`.

**Select all seven files at once.** Each file is identified by its header, not its
name, so one upload can carry Google + Meta + Queries + Pages + Chart +
**Search Appearance** + GA4. Search Appearance.csv is the recommended 7th file.
The response is a receipt: per-file kind, row count, and date span, plus the
`skipped` list for anything unrecognised.

**Upload never truncates.** Daily rows upsert on their key, so a 7-day export
overwrites only those 7 days and leaves the rest of the history alone. Only the
undated GSC snapshots (`Queries.csv`, `Pages.csv`, `Search Appearance.csv`)
replace the previous snapshot of that same kind — they carry no date to key on.

**Freshness** is measured against the real calendar (`America/New_York`), not the
file as-of. Google / GA4 / GSC age from API `max(metric_date)` and show
`fetched_at`. Meta CSV still asks for a fresh export once it is
`STALE_AFTER_DAYS` (7) behind. Range windows still key off the loaded as-of.

The **Data** panel is the answer to "what is loaded and is it current?" — per
source it shows row count, full history span, newest date, age in days, and how
much of the selected window that source actually covers. Coverage is
lag-adjusted: Search Console trails ~2 days, so a complete-to-its-own-max source
reads 100%, while a genuinely thin window (a 30-day GA4 export asked to fill 90
days) is flagged amber and listed in `freshness.partial_sources`. Longer windows
are built by accumulation — upload 7 days a week and the 14 / 30 / 90 / 365
windows fill in over time.

Intel is two desks (max 6 each, ranked by $ at stake): **Paid media** for the ads
lead and **Site & conversion** for the web team. Every card is a 7-day test with
a keep/kill metric. Never move Meta/PMax onto Brand Search. Win/lose tables
require spend ≥ $1.

Copy for Grok = keep/kill prompt + numbered stack + **Upload yield** evidence
(Search appearance, worst Google impr share / top IS, top GSC pages, paid GA4
landers) + JSON snapshot (`search_appearance[]` and campaign share fields when
present). Each desk also exports on its own, and each card carries a
self-contained prompt.

Migration: `supabase/migration_paid_intel.sql` plus additive
`supabase/migration_paid_intel_appearance.sql` (CHECK widen + share columns;
no DROP TABLE, no RLS).

## Outcome loop

Every card declares an `IntelCheck` — one number, a direction, and the value
that counts as a pass. **I did this** freezes that number as the baseline in
`paid_intel_decisions`. The next upload with a newer as-of re-measures it and
grades the change: worked / holding / improving / no change / went wrong way.
A card applied in an earlier week keeps its grade even when it re-fires, so
"we cut this three weeks running and nothing moved" is visible.

Decisions are keyed `(card_id, as_of)`, so last week's decision is never
overwritten by this week's. Applied/dismissed cards move to `log` and stop
consuming the 12 open recommendation slots.

## Meta ad-set exports

An ad-set or ad-level export carries several rows per campaign per day. Those
are **summed** into the campaign-day, never last-wins — the warehouse key is
`platform|date|campaign_name`, so keeping one row would silently drop the rest
of the campaign's spend. Ad-set frequency is also kept as `frequency_peak`,
because a campaign-weighted average hides one burnt-out ad set.

## Product attribution

PMax and Brand Search campaign names carry no product, which left ~70% of spend
as "other". Those campaigns are now split across product lines by where paid
GA4 traffic actually landed (`/products/...` key events, then revenue, then
sessions). The ads conversion-value **total is never replaced** by GA4 revenue —
only its distribution across products is estimated, and every estimated row is
flagged `estimated: true`.

---

# Ads Ops window feed (still supported)

Structured JSON may still be upserted into `paid_ads_snapshots` /
`paid_ads_campaigns_window` via `POST /api/paid-ads/ingest`. That path is
**not** a live scrape. See git history for the payload shape. The page
now reads the daily warehouse first.
