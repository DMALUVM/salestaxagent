# Paid Ads (Shopify) — Ads Ops feed

The `/paid-ads` page shows Google Ads (and later Meta) for the Shopify
storefront. **Amazon PPC stays on `/ppc` and in `ads_*` tables.**

Data is a **structured Ads Ops payload**, upserted into Supabase. This is
**not** a live scrape of Google Ads Manager or Meta Ads Manager.

Dashboard Agent may upsert the same rows directly in Supabase when Ads Ops
sends the payload in chat. The HTTP path is `POST /api/paid-ads/ingest`
(dashboard Basic Auth + service-role key).

## Channels

`google_ads` | `meta_ads` only. Amazon / PPC aliases are rejected.

## Tables (`supabase/migration_paid_ads.sql`)

| Table | Grain |
|---|---|
| `paid_ads_daily` | `(channel, date)` account rollup |
| `paid_ads_campaigns_daily` | `(channel, date, campaign_id)` |
| `paid_ads_snapshots` | `(channel, as_of, window_days)` for 1 / 7 / 14 / 30 |

The GET route prefers a snapshot whose `as_of` is the latest date for that
channel; otherwise it rolls daily rows for the inclusive window.

## Payload

```json
{
  "channel": "google_ads",
  "as_of": "2026-08-22",
  "currency": "USD",
  "source": "ads_ops",
  "account": {
    "spend": 42.15,
    "sales_or_conv_value": 168.60,
    "clicks": 30,
    "impressions": 1200,
    "conversions": 4
  },
  "windows": [
    {
      "window_days": 1,
      "spend": 42.15,
      "sales_or_conv_value": 168.60,
      "clicks": 30,
      "impressions": 1200,
      "conversions": 4
    },
    {
      "window_days": 7,
      "spend": 280.00,
      "sales_or_conv_value": 980.00,
      "clicks": 210,
      "impressions": 8400,
      "conversions": 28,
      "campaigns": [
        {
          "campaign_id": "123",
          "campaign_name": "Brand — Exact",
          "spend": 90.00,
          "sales_or_conv_value": 360.00,
          "clicks": 70,
          "impressions": 2000,
          "conversions": 12
        }
      ]
    }
  ],
  "daily": [
    {
      "date": "2026-08-22",
      "spend": 42.15,
      "sales_or_conv_value": 168.60,
      "clicks": 30,
      "impressions": 1200,
      "conversions": 4
    }
  ],
  "campaigns": [
    {
      "campaign_id": "123",
      "campaign_name": "Brand — Exact",
      "date": "2026-08-22",
      "spend": 12.00,
      "sales_or_conv_value": 48.00,
      "clicks": 8,
      "impressions": 300,
      "conversions": 1
    }
  ]
}
```

Aliases accepted on metrics: `cost`/`spend`, `sales`/`conversion_value`/
`sales_or_conv_value`, `imps`/`impressions`, `purchases`/`conversions`.
`cpc` and `roas` are optional; the dashboard re-derives them from totals
(`spend/clicks`, `sales_or_conv_value/spend`) when rolling windows.

- Dated `campaigns[]` write `paid_ads_campaigns_daily`.
- Undated `campaigns[]` land on `as_of` unless `window_days` / `campaign_window_days`
  is 7/14/30 — then they attach to that snapshot’s `metrics.campaigns`.
- `windows[]` write `paid_ads_snapshots`. A 1-day window also fills
  `paid_ads_daily` when no daily row exists for `as_of`.

## Read

`GET /api/paid-ads` (optional `?channel=google_ads&window=7`) — service role.
The page never queries these tables from the browser anon client.
