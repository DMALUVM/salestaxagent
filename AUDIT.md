# Sales Tax Agent — Audit (2026-08-17)

## Feature Matrix

| Feature | Status | Notes |
|---|---|---|
| **A. Autonomy** | | |
| launchd KeepAlive + RunAtLoad | PRESENT | Survives reboot |
| Shopify poll (2h) | PRESENT | |
| SP-API refresh (daily 06:00) | PRESENT | |
| Daily analysis (08:00) | PRESENT | |
| Deadline check (09:00) | PRESENT | |
| CPA exports (06:30) | PRESENT | |
| Job worker (45s) | PRESENT | |
| Telegram daily digest | MISSING | daily_digest.py exists but not wired to scheduler |
| Inventory sync job | MISSING | src/inventory/ exists but not in scheduler |
| 3PL sync job | MISSING | src/shipsidekick/ exists but not in scheduler |
| Stale sync Telegram alert | MISSING | No alert on failed sync |
| Data page sync timestamps | PRESENT | Shows ingestion_log |
| Data page refresh button | PRESENT | Enqueues via /api/spapi-refresh |
| **B. Sales Tax** | | |
| Shopify ingest → sales_by_state | PRESENT | With source_name channel split |
| Amazon SP-API orders | PRESENT | Chunked by month |
| Physical nexus (FBA) | PRESENT | Tier-based |
| Economic nexus thresholds | PRESENT | |
| Franchise flags (CA/TX/WA) | PRESENT | |
| Registrations page | PRESENT | service-role save via /api/registrations |
| registration-model.ts | PRESENT | Shared REGISTER_NOW/MONITOR/REGISTERED |
| Filings page | PRESENT | Mark filed, period sales, due dates |
| Liability page | PRESENT | Seller vs marketplace split |
| Filing packet export | MISSING | No CSV/JSON export of filing data |
| Telegram overdue/due_soon | MISSING | telegram_policy.py exists but not wired |
| **C. Shop Channel** | | |
| classify_shopify_order() | PRESENT | source_name → shopify / shopify_shop |
| is_seller_responsible() | PRESENT | |
| Liability uses channel split | PRESENT | 3-way: seller / Shopify-remits / Amazon-remits |
| Filings uses seller-only | PRESENT | isSellerResponsible filter |
| DB migration | PRESENT | migration_shop_channel.sql (needs manual run) |
| **D. Inventory** | | |
| src/inventory/ modules | PRESENT | sync, velocity, report, awd, capacity |
| src/shipsidekick/ | PRESENT | Ship Sidekick 3PL client |
| /inventory dashboard | PRESENT | 1045 lines |
| /inventory/plan dashboard | PRESENT | 659 lines |
| /api/inventory route | PRESENT | service-role |
| Inventory CLI commands | MISSING | Not on main branch |
| Inventory scheduler job | MISSING | Not wired |
| Seasonality data | PRESENT | In DB from prior session |
| **E. Safety** | | |
| github_backup disabled | PRESENT | ENABLED=False, hard guards |
| Disclaimers | PRESENT | Multiple pages |
| No e-file automation | PRESENT | |

## Gaps to Fix (Phase 1)

1. Wire daily_digest + telegram_policy to scheduler
2. Wire inventory sync + velocity + 3PL to scheduler
3. Add inventory CLI commands (inventory-sync, inventory-velocity, inventory-report, plan-sku)
4. Add filing packet export (CSV per state)
5. Add stale-sync Telegram alert
6. Verify economic nexus doesn't double-count

## Deferred (not in scope)

- Prometheus / monitoring stack
- Re-enable github_backup
- State portal e-filing automation
- Local tax rate integration
- Exemption certificate tracking
- Multi-entity support
