# Paid Ads (Shopify) — Ads Ops feed

The `/paid-ads` page shows Google Ads (and later Meta) for the Shopify
storefront. **Amazon PPC stays on `/ppc` and in `ads_*` tables.**

Data is a **structured Ads Ops payload**, upserted into the production
tables that already hold the first `google_ads` rows (`as_of` 2026-08-22).
This is **not** a live scrape of Google or Meta Ads Manager.

Dashboard Agent may upsert the same uniques in Supabase when Ads Ops
sends the payload in chat. HTTP path: `POST /api/paid-ads/ingest`
(dashboard Basic Auth + service-role key).

## Channels

`google_ads` | `meta_ads` only. Amazon / PPC aliases are rejected.

## Tables (production; `supabase/migration_paid_ads.sql` is IF NOT EXISTS)

| Table | Unique |
|---|---|
| `paid_ads_snapshots` | `(channel, as_of, window_days)` |
| `paid_ads_campaigns_window` | `(channel, as_of, window_days, campaign_name)` |

Windows: **1 / 7 / 14 / 30**. Metric column is **`conv_value`** (not
`sales_or_conv_value`). `as_of` is a `date`. Campaign `campaign_id` is
optional — the first Google rows key on `campaign_name` only.

Do not drop these tables or truncate rows. The dashboard **reads these
two tables**. Ingest upserts the same uniques.

## Payload

```json
{
  "channel": "google_ads",
  "as_of": "2026-08-22",
  "currency": "USD",
  "source": "scheduled_report_baselines",
  "account_label": "Tallowbourn 533-220-6723",
  "notes": ["Meta not connected"],
  "windows": [
    {
      "window_days": 7,
      "window_start": "2026-08-15",
      "window_end": "2026-08-21",
      "spend": 593.47,
      "conv_value": 721.26,
      "roas": 1.22,
      "clicks": 343,
      "impressions": 55183,
      "conversions": 30,
      "cpc": 1.73
    },
    {
      "window_days": 30,
      "spend": 2175.01,
      "conv_value": 3435.53,
      "roas": 1.58,
      "clicks": 1301,
      "impressions": 212233,
      "conversions": 119.86,
      "cpc": 1.67,
      "campaigns": [
        {
          "campaign_name": "PMAX Max Conversions V4",
          "spend": 964.80,
          "roas": 1.37,
          "status": "active",
          "note": "dominant last 7d"
        }
      ]
    }
  ],
  "campaigns": [
    {
      "campaign_name": "BRANDED Search V1",
      "window_days": 30,
      "spend": 378.11,
      "roas": 2.16,
      "status": "active"
    }
  ]
}
```

Aliases: `cost`/`spend`, `conv_value`/`sales`/`sales_or_conv_value`,
`imps`/`impressions`. `cpc` and `roas` are optional on ingest; the page
re-derives them from totals when a snapshot omits them.

If `window_start` / `window_end` are omitted, they are filled as
`[as_of − window_days, as_of − 1]` (the grain of the first Google rows).

Top-level `campaigns[]` without `window_days` attach to
`campaign_window_days` / `window_days`, else the largest window in the
payload, else 30.

## Read

`GET /api/paid-ads` (optional `?channel=google_ads&window=7`) — service role.
The page never queries these tables from the browser anon client.
