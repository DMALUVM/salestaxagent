# Production audit — sales-tax + Amazon PPC agent

**Date:** 2026-08-21 · **Window used throughout:** 2026-08-14 → 2026-08-20,
7 closed days, `America/Los_Angeles` (Amazon day boundary, business rule 1).
Prior window 2026-08-07 → 2026-08-13.

Ground truth for every consistency check was computed by an independent
paginated rollup, not by reusing the modules under audit:

```
spend $3,010.34 · ad sales $7,520.84 · orders 508 · clicks 1,924 (1,408 rows)
ACOS 40.03% · ROAS 2.4983x · TACoS 13.70% · Amazon sales $21,965.40
prior: spend $2,802.38 · sales $7,515.67 · ACOS 37.29% · open P0 = 8
```

---

## CRITICAL

### C-1 Two jobs regenerated the recommendation queue at 06:00 with different break-even

`src/main.py` — `_run_spapi_refresh` called
`generate_recommendations(target_acos=30)` while `_run_ads_actions`, scheduled
**the same minute**, called it with `account_target_acos()` = **36.9%**.

Both write the same `ads_recommendations` table. Whichever finished last decided
what the dashboard Actions tab, the PPC brief's P0/P1 tables and the health
check-in's P0 count all reported. A term profitable at 36.9% was cut or kept
depending on a race. This is also the "second hardcoded break-even" the audit
brief asked about.

**Fixed** — the flat-30 call is removed; `ads_actions` is the sole owner of the
queue. Recent runs confirm `88 recs (7d, target 36.9%)`.

### C-2 Auth-failure detection had never run

`src/health.py` selected `job_runs.error_message`. That column does not exist —
it is `message`. PostgREST raised, and a bare `except Exception: pass` swallowed
it, so the check reported no auth failures *because it was broken*. One of the
five failure modes the health job exists to catch was dead from the day it
shipped.

**Fixed** — correct column, and a failed check now raises its own `check_broken`
fault. A check that could not run is not a check that passed.

---

## HIGH

### H-1 Three Telegram messages every morning; two were near-duplicates

08:00 `send_daily_summary` (tax/nexus), 08:05 `send_digest`, 08:10 health
check-in. The first two **both render from `digest_sections.build_sections`** —
the same registration-aware sections, five minutes apart.

**Fixed** — the 08:05 job is retired (`daily_digest` still runs on demand). Its
two unique pieces moved into the 08:10 check-in rather than being dropped:

- **failed jobs in 24h**, by name — this was the *only* place a broken job was
  reported, and `inventory_sync` had been failing daily with nobody told;
- **MTD sales by channel**.

### H-2 The retired digest's MTD figure was wrong

The digest computed MTD from `sales_by_state`; the check-in computes it from
`sales_daily` (single-source `amazon_spapi`, one row per day).

```
digest      MTD Amazon $25,032.95
sales_daily MTD Amazon $63,956.32   (21 rows, ~$3,045/day)
7d window   $21,965.40              (~$3,138/day)  ← corroborates sales_daily
```

The digest was **understating Amazon MTD by roughly 60%**. Retiring it removed a
wrong number, not just a duplicate one.

### H-3 `brand-share` CLI silently dropped the oldest 3 weeks

Three defects stacked in one query, and the cross-surface check is what exposed
them. Ground truth, computed independently:

```
sqp_weekly: 24,042 rows · 33 distinct weeks · 2025-12-28 → 2026-08-09 · contiguous
```

1. **`weeks stored : 15`** was `--weeks` (the display cap), not the stored count.
2. **`.order("week_start", desc=True)`** with `.range()` across 25 pages and no
   unique tiebreak — page boundaries undefined, rows drop and duplicate. Same
   defect already fixed in `/api/brand-share`.
3. **`len(rows) > 20000`** combined with DESC ordering discarded the *oldest*
   rows once the table outgrew the cap. The SQP backfill pushed the table past
   24,000 rows during this audit, and the CLI quietly began reporting **30**
   weeks from 2026-01-18 while health and the brief reported **33** from
   2025-12-28.

**Fixed** — ascending order with an `id` tiebreak, cap raised to 200k and made
**loud** (prints a WARNING when hit), true stored count printed separately from
the display cap. All three surfaces now agree:

```
CLI:    weeks stored : 33  (2025-12-28 → 2026-08-09)
health: SQP history 33w
brief:  Weeks stored: 33
```

A row cap is not forbidden. A silent one is. Pinned by
`tests/test_sqp_pagination.py`.

### H-4 `ppc-export --publish` was never scheduled

The dashboard's stored fallback only ever held whatever was last published by
hand, which is exactly the weekly terminal step this system exists to remove. It
also meant a stored brief could sit on an old format version indefinitely.

**Fixed** — scheduled daily at **07:30**, after ads sync (05:00–05:30), the
actions rebuild (06:00) and outcome snapshots (07:00). Never sent to Telegram.

### H-5 Dashboard Target ACOS defaulted to a hardcoded 30

`useState(30)` in `dashboard/src/app/ppc/page.tsx`, while `/api/ppc` already
returns the real break-even. It fed the Generate button and the exported plan.

**Fixed** — derived as `override ?? data.targetAcos ?? 30`. No new hook, no
effect (see the #310 incident).

---

## MEDIUM — documented, not fixed

| # | Finding | File |
|---|---|---|
| M-1 | `_run_spapi_refresh` also calls `sync_ads(days=14)`, duplicating the 05:00 `ads_campaigns_sync(30d)`. Ads are fetched twice daily. | `src/main.py` |
| M-2 | `export_brief.gather()` pulls the **entire** `sqp_weekly` table (16k rows, 17 requests) on every brief build. Should be bounded to the ~52 weeks the brief can show. | `src/amazon_ads/export_brief.py` |
| M-3 | `inventory_sync` failed daily on `auth_headers_with_retry`. The import resolves in currently-loaded code; unproven until the next 06:30 run. | `src/inventory/` |
| M-4 | 2 pre-existing failures in `tests/test_parsers.py::TestStateRules` (CA/TX). They fail on a clean tree and are state sales-tax rules — out of scope, untouched. | `tests/test_parsers.py` |

---

## PASSED

- **C1/C3 consistency** — `/api/ppc`, `ppc-export` grade economics and the
  health scoreboard all matched ground truth exactly ($3,010.34 / $7,520.84 /
  40.0% / 2.50x / 13.7%, P0 = 8).
- **C5 source quarantine** — `economic_nexus.py` hard-excludes quarantined
  sources via `is_quarantined_source` *before* aggregation; the SP-API-preferring
  dedup is a documented no-op safety net. **No double count.**
- **C6 rank bands** — one `SHARE_TO_RANK` constant, used by `share_to_rank()`.
  The gate, brief §5 and the playbook all describe it as an SQP click-share band,
  never a SERP position.
- **C7 pagination** — both `sqp_weekly` readers paginate; the only unstable
  ORDER BY was H-4.
- **D format 2.0.0** — live and stored both carry `format_version`; stored serves
  with a `-stored` filename and a red warning; download returns
  `Content-Disposition: attachment`, and a failure returns JSON 503 rather than
  saving an error body as `.md`.
- **G security** — `.env*` gitignored and untracked; service key appears only in
  server routes, never in a client component; no tokens in logs; heartbeat and
  health-state gitignored.

---

## Operator map

**Automatic — never needs a terminal**

| Time (ET) | Job |
|---|---|
| every 5 min | heartbeat |
| 05:00 / 05:15 / 05:30 | ads campaigns / placements / search terms |
| 06:00 | SP-API refresh · **ads actions** (sole owner of the queue) |
| 06:30 / 06:35 / 06:45 | inventory · 3PL · contribution P&L |
| 07:00 | action outcome snapshots |
| **07:30** | **PPC brief publish** → dashboard buttons |
| 08:00 | daily analysis + tax/nexus summary (Telegram) |
| **08:10** | **health check-in** (Telegram, one per day) |
| 09:00 | deadline check |
| Mon 10:00 PT | SQP sync → organic-rank gate |
| Sun 03:00 / 04:00 / 09:00 | ads backfill · ledger backfill · GitHub backup |

**Stays human — deliberately**

- Applying bids, negatives and placement modifiers in Seller Central. Nothing
  writes to Amazon.
- `ads-mark --priority P0 --apply` after applying. **This is the only routine
  terminal step left**, and it is the one that closes the learning loop —
  0 of 88 recommendations are marked, so every brief is still RULES-BASED ONLY.

**When to use the dashboard**

- *Download brief* / *Copy full AI brief* — any time; live when the agent is
  reachable, otherwise the 07:30 stored copy, clearly labelled.
- A **missing 08:10 Telegram message is itself an alarm** — a dead scheduler
  cannot report on itself.

---

## Re-verify after changes

```bash
python -m src.main health-ping --dry-run          # faults + scoreboard
python -m src.main brand-share | head -3          # stored vs shown week counts
python -m src.main ppc-export --publish           # grade + stored copy
python -m src.main jobs --failures                # what actually broke
pytest tests/ -q                                  # 2 known pre-existing fails
cd dashboard && npm test && npm run build
launchctl kickstart -k gui/$(id -u)/com.tallowbourn.salestax
grep -E "^\[Scheduler\]" logs/agent.out.log | tail -24
```

SQP figures are the **ASIN view**: they cover queries our ASINs appeared in, not
the full category. Nothing here claims category market share.
