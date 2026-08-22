"""PPC action learning foundation: decision log + outcome snapshots.

The question this is built to answer later: *which action types actually moved
contribution?* Nothing here trains a model, ranks actions, or writes to Amazon.
It records what was recommended, on what evidence, and what happened next.

Two halves:

  log_decisions()      — called by the actions engine on every run. Appends one
                         row per action per as-of date with the evidence FROZEN
                         as it stood at decision time.
  snapshot_outcomes()  — nightly. For applied/dismissed decisions, once the
                         +7/+14/+30 closed day has actually arrived, records
                         what the entity, the role and the account did over the
                         window that FOLLOWS the decision.

Two properties matter for the dataset to be usable later:

  No leakage — the evidence column is written once, at decision time, and never
  updated. Outcomes live in a separate table, so a future training set can join
  them without a post-decision value ever having been folded into the features.

  Idempotence — snapshots are keyed UNIQUE (decision_id, horizon_days) and the
  writer skips horizons whose window has not closed, so re-running the job is
  safe and a partial window is never recorded as if it were complete.

Requires supabase/migration_ads_learning.sql. Absent that, every function here
no-ops with a log line: the actions queue keeps working, it just is not logged.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from src.amazon_ads.strategy import STRATEGY, classify_campaign, load_strategy
from src.rules import amazon_as_of, window_start

log = logging.getLogger(__name__)

DECISIONS_TABLE = "ads_action_decisions"
OUTCOMES_TABLE = "ads_action_outcomes"


def _learning_cfg() -> dict:
    return (load_strategy().get("learning")
            or STRATEGY.get("learning")
            or {"snapshot_offsets_days": [7, 14, 30],
                "snapshot_statuses": ["applied", "dismissed"]})


def _missing_table(err: Exception, table: str) -> bool:
    msg = str(err)
    return table in msg and ("schema cache" in msg or "does not exist" in msg)


def _as_dict(v) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


# ── Decision log ────────────────────────────────────────────────

def log_decisions(recs: list[dict], as_of: date | None = None,
                  run_id: str | None = None) -> dict:
    """Append one decision row per recommendation for `as_of`.

    Returns {"logged": n} or {"skipped": reason}. Never raises into the caller:
    a failure to log must not stop the actions queue from being written.
    """
    if not recs:
        return {"logged": 0}

    as_of = as_of or amazon_as_of()
    rows = []
    for r in recs:
        ev = _as_dict(r.get("evidence"))
        action_type = ev.get("action_type") or r.get("type", "").lower()
        entity_type = r.get("entity_type") or ""
        rows.append({
            "as_of_date": as_of.isoformat(),
            "run_id": run_id,
            "action_type": action_type,
            "rec_type": r.get("type"),
            "priority": r.get("priority"),
            "campaign_id": str(r.get("campaign_id") or ""),
            "campaign_name": r.get("campaign_name") or "",
            "ad_group_id": str(r.get("ad_group_id") or ""),
            "role": ev.get("role") or classify_campaign(r.get("campaign_name") or ""),
            "entity_type": entity_type,
            "entity_name": r.get("entity_name") or "",
            # Only set when the action actually targets one, so the column can
            # be filtered on without guessing from entity_type later.
            "search_term": r.get("entity_name") if entity_type == "search_term" else None,
            "placement": ev.get("placement_tos") and "Top of Search on-Amazon" or None,
            "suggested_change": {
                "suggested_action": r.get("suggested_action"),
                "suggested_bid": ev.get("suggested_bid"),
                "step_pct": ev.get("step_pct"),
                "verdict": ev.get("verdict"),
                "target_acos": ev.get("target_acos"),
            },
            # Frozen. Written once; the outcome writer never touches this.
            "evidence": ev,
            "impact_estimate": r.get("impact_estimate"),
            "status": r.get("status") or "open",
        })

    try:
        from src.db import get_client
        client = get_client()
        inserted = 0
        for i in range(0, len(rows), 500):
            resp = (client.table(DECISIONS_TABLE)
                    .upsert(rows[i:i + 500],
                            on_conflict="as_of_date,rec_type,entity_name,campaign_id")
                    .execute())
            inserted += len(resp.data or [])
        log.info("Decision log: %d action(s) recorded for %s", inserted, as_of)
        return {"logged": inserted, "as_of": as_of.isoformat()}
    except Exception as e:
        if _missing_table(e, DECISIONS_TABLE):
            log.info("%s not present — decisions not logged "
                     "(run supabase/migration_ads_learning.sql)", DECISIONS_TABLE)
            return {"skipped": "table missing"}
        log.warning("Could not write decision log: %s", str(e)[:200])
        return {"skipped": str(e)[:200]}


def link_recommendations(as_of: date | None = None) -> int:
    """Point live queue rows at their decision row.

    Matched on the natural key the two share, so the dashboard's apply/dismiss
    can update both without the engine having to thread ids through.
    """
    as_of = as_of or amazon_as_of()
    try:
        from src.db import get_client
        client = get_client()
        decisions = (client.table(DECISIONS_TABLE)
                     .select("id,rec_type,entity_name,campaign_id")
                     .eq("as_of_date", as_of.isoformat())
                     .execute().data) or []
        by_key = {(d["rec_type"], d["entity_name"], d["campaign_id"]): d["id"]
                  for d in decisions}
        recs = (client.table("ads_recommendations")
                .select("id,type,entity_name,campaign_id")
                .eq("status", "open").execute().data) or []
        linked = 0
        for r in recs:
            did = by_key.get((r["type"], r["entity_name"], str(r.get("campaign_id") or "")))
            if did:
                client.table("ads_recommendations").update(
                    {"decision_id": did}).eq("id", r["id"]).execute()
                linked += 1
        return linked
    except Exception as e:
        if _missing_table(e, DECISIONS_TABLE) or "decision_id" in str(e):
            return 0
        log.warning("Could not link recommendations to decisions: %s", str(e)[:160])
        return 0


MARKABLE = ("applied", "dismissed", "open", "expired")


def decision_patch(status: str, now: datetime | None = None) -> dict | None:
    """The exact columns ads-mark and the dashboard write onto a decision row.

    Isolated so tests can pin the payload without a database. Invalid statuses
    return None — callers must not invent a fourth state.
    """
    if status not in MARKABLE:
        return None
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    patch: dict = {"status": status}
    if status == "applied":
        patch["applied_at"] = stamp
    elif status == "dismissed":
        patch["dismissed_at"] = stamp
    elif status == "expired":
        patch["expired_at"] = stamp
    return patch


def resolve_decision_id(rec: dict, *, client=None) -> str | None:
    """Find the decision row for a live recommendation.

    Prefers the linked decision_id. If that was never written (link_recommendations
    missed a row), fall back to the natural key the two tables share so Apply
    still closes the loop instead of updating the queue alone.
    """
    did = rec.get("decision_id")
    if did:
        return str(did)
    try:
        if client is None:
            from src.db import get_client
            client = get_client()
        rows = (client.table(DECISIONS_TABLE)
                .select("id")
                .eq("rec_type", rec.get("type"))
                .eq("entity_name", rec.get("entity_name") or "")
                .eq("campaign_id", str(rec.get("campaign_id") or ""))
                .order("as_of_date", desc=True)
                .limit(1).execute().data) or []
        return str(rows[0]["id"]) if rows else None
    except Exception as e:
        if not _missing_table(e, DECISIONS_TABLE):
            log.warning("Could not resolve decision for rec %s: %s",
                        rec.get("id"), str(e)[:160])
        return None


def mark_decision(decision_id: str, status: str) -> bool:
    """Mirror an apply/dismiss onto the decision row. Called by the API."""
    patch = decision_patch(status)
    if patch is None:
        return False
    try:
        from src.db import get_client
        get_client().table(DECISIONS_TABLE).update(patch).eq("id", decision_id).execute()
        return True
    except Exception as e:
        if not _missing_table(e, DECISIONS_TABLE):
            log.warning("Could not mark decision %s as %s: %s", decision_id, status, str(e)[:160])
        return False


def mark_recommendation(rec: dict, status: str, *, client=None) -> dict:
    """The one apply/dismiss path: queue row + decision log.

    ads-mark and the dashboard API must both end here. Never writes to Amazon.
    Returns {"ok", "decisionLogged", "decisionId"} so the UI can say whether
    the learning loop was actually closed.
    """
    patch = decision_patch(status)
    if patch is None:
        return {"ok": False, "decisionLogged": False, "decisionId": None,
                "error": f"invalid status {status!r}"}
    rec_id = rec.get("id")
    if not rec_id:
        return {"ok": False, "decisionLogged": False, "decisionId": None,
                "error": "recommendation id required"}
    try:
        if client is None:
            from src.db import get_client
            client = get_client()
        client.table("ads_recommendations").update(
            {"status": status}).eq("id", rec_id).execute()
        decision_id = resolve_decision_id(rec, client=client)
        logged = False
        if decision_id:
            client.table(DECISIONS_TABLE).update(patch).eq("id", decision_id).execute()
            logged = True
        return {"ok": True, "decisionLogged": logged, "decisionId": decision_id}
    except Exception as e:
        if not _missing_table(e, DECISIONS_TABLE):
            log.warning("Could not mark recommendation %s as %s: %s",
                        rec_id, status, str(e)[:160])
        return {"ok": False, "decisionLogged": False, "decisionId": None,
                "error": str(e)[:200]}


# ── Outcome snapshots ───────────────────────────────────────────

def _entity_window_metrics(client, decision: dict,
                           start: date, end: date) -> dict:
    """Post-decision performance for whatever the action targeted."""
    campaign_id = str(decision.get("campaign_id") or "")
    term = decision.get("search_term")
    agg = {"spend": 0.0, "ad_sales": 0.0, "clicks": 0, "orders": 0}

    if term:
        rows = (client.table("ads_search_terms_daily")
                .select("spend,sales_14d,orders_14d,clicks")
                .eq("search_term", term).eq("campaign_id", campaign_id)
                .gte("date", start.isoformat()).lte("date", end.isoformat())
                .execute().data) or []
        source = "ads_search_terms_daily"
    else:
        rows = (client.table("ads_campaigns_daily")
                .select("spend,sales_14d,orders_14d,clicks")
                .eq("campaign_id", campaign_id)
                .gte("date", start.isoformat()).lte("date", end.isoformat())
                .execute().data) or []
        source = "ads_campaigns_daily"

    for r in rows:
        agg["spend"] += float(r.get("spend") or 0)
        agg["ad_sales"] += float(r.get("sales_14d") or 0)
        agg["clicks"] += int(r.get("clicks") or 0)
        agg["orders"] += int(r.get("orders_14d") or 0)

    agg["acos"] = (agg["spend"] / agg["ad_sales"] * 100) if agg["ad_sales"] > 0 else None
    agg["rows"] = len(rows)
    agg["source"] = source
    return agg


def _context_window_metrics(client, start: date, end: date) -> dict:
    """Account and per-role spend, plus P&L contribution, for the window.

    Computed once per (start, end) and reused across decisions sharing it.
    """
    campaigns = []
    offset = 0
    while True:
        page = (client.table("ads_campaigns_daily")
                .select("campaign_name,spend")
                .gte("date", start.isoformat()).lte("date", end.isoformat())
                .range(offset, offset + 999).execute().data) or []
        campaigns.extend(page)
        if len(page) < 1000:
            break
        offset += 1000

    account_spend = sum(float(c.get("spend") or 0) for c in campaigns)
    role_spend: dict[str, float] = defaultdict(float)
    for c in campaigns:
        role_spend[classify_campaign(c.get("campaign_name") or "")] += float(c.get("spend") or 0)

    pnl = (client.table("pnl_daily")
           .select("gross_sales,net_after_ads")
           .eq("grain", "account")
           .gte("date", start.isoformat()).lte("date", end.isoformat())
           .execute().data) or []
    gross = sum(float(r.get("gross_sales") or 0) for r in pnl)
    contribution = sum(float(r.get("net_after_ads") or 0) for r in pnl)

    return {
        "account_spend": round(account_spend, 2),
        "account_tacos": round(account_spend / gross * 100, 2) if gross > 0 else None,
        "role_spend": {k: round(v, 2) for k, v in role_spend.items()},
        "gross_sales": round(gross, 2),
        "contribution": round(contribution, 2),
        "pnl_days": len(pnl),
    }


def snapshot_outcomes(as_of: date | None = None, dry_run: bool = False) -> dict:
    """Write outcome rows for decisions whose horizon window has closed.

    Idempotent: a horizon already recorded is skipped, and a horizon whose
    window ends after `as_of` is not written at all — a partial window must
    never be stored as if it were complete.
    """
    as_of = as_of or amazon_as_of()
    cfg = _learning_cfg()
    offsets = [int(o) for o in cfg.get("snapshot_offsets_days", [7, 14, 30])]
    statuses = list(cfg.get("snapshot_statuses", ["applied", "dismissed"]))

    result = {"as_of": as_of.isoformat(), "offsets": offsets,
              "written": 0, "skipped_not_due": 0, "already_present": 0,
              "decisions_considered": 0}

    try:
        from src.db import get_client
        client = get_client()

        decisions = (client.table(DECISIONS_TABLE)
                     .select("id,as_of_date,applied_at,dismissed_at,status,"
                             "campaign_id,campaign_name,role,search_term,"
                             "entity_name,rec_type,action_type")
                     .in_("status", statuses)
                     .execute().data) or []
        result["decisions_considered"] = len(decisions)
        if not decisions:
            return result

        existing = (client.table(OUTCOMES_TABLE)
                    .select("decision_id,horizon_days").execute().data) or []
        have = {(e["decision_id"], e["horizon_days"]) for e in existing}

        context_cache: dict[tuple[str, str], dict] = {}
        to_write: list[dict] = []

        for d in decisions:
            # Anchor on when the action was actually taken; fall back to the
            # decision date so a dismissal recorded without a timestamp still
            # measures from a defined point.
            anchor_raw = d.get("applied_at") or d.get("dismissed_at") or d.get("as_of_date")
            try:
                anchor = (datetime.fromisoformat(str(anchor_raw).replace("Z", "+00:00")).date()
                          if "T" in str(anchor_raw) else date.fromisoformat(str(anchor_raw)))
            except Exception:
                anchor = date.fromisoformat(d["as_of_date"])

            for horizon in offsets:
                if (d["id"], horizon) in have:
                    result["already_present"] += 1
                    continue
                window_end = anchor + timedelta(days=horizon)
                if window_end > as_of:
                    result["skipped_not_due"] += 1
                    continue
                window_begin = anchor + timedelta(days=1)  # day after the decision

                ck = (window_begin.isoformat(), window_end.isoformat())
                if ck not in context_cache:
                    context_cache[ck] = _context_window_metrics(client, window_begin, window_end)
                ctx = context_cache[ck]

                ent = _entity_window_metrics(client, d, window_begin, window_end)
                role = d.get("role") or ""
                rspend = ctx["role_spend"].get(role)

                to_write.append({
                    "decision_id": d["id"],
                    "horizon_days": horizon,
                    "anchor_date": anchor.isoformat(),
                    "window_start": window_begin.isoformat(),
                    "window_end": window_end.isoformat(),
                    "spend": round(ent["spend"], 2),
                    "ad_sales": round(ent["ad_sales"], 2),
                    "acos": round(ent["acos"], 2) if ent["acos"] is not None else None,
                    "clicks": ent["clicks"],
                    "orders": ent["orders"],
                    "account_spend": ctx["account_spend"],
                    "account_tacos": ctx["account_tacos"],
                    "role_spend": rspend,
                    "role_tacos": (round(rspend / ctx["gross_sales"] * 100, 2)
                                   if rspend and ctx["gross_sales"] else None),
                    "contribution": ctx["contribution"],
                    "gross_sales": ctx["gross_sales"],
                    "meta": {
                        "entity_source": ent["source"],
                        "entity_rows": ent["rows"],
                        "pnl_days": ctx["pnl_days"],
                        "action_type": d.get("action_type"),
                        "note": "observational; no control group",
                    },
                })

        result["due"] = len(to_write)
        if dry_run:
            result["sample"] = to_write[:3]
            return result

        for i in range(0, len(to_write), 500):
            client.table(OUTCOMES_TABLE).upsert(
                to_write[i:i + 500], on_conflict="decision_id,horizon_days").execute()
        result["written"] = len(to_write)
        log.info("Outcome snapshots: %d written, %d not due, %d already present (as_of %s)",
                 result["written"], result["skipped_not_due"],
                 result["already_present"], as_of)
        return result

    except Exception as e:
        if _missing_table(e, DECISIONS_TABLE) or _missing_table(e, OUTCOMES_TABLE):
            log.info("Learning tables not present — no outcome snapshots "
                     "(run supabase/migration_ads_learning.sql)")
            return {**result, "skipped": "tables missing"}
        log.exception("Outcome snapshot failed")
        return {**result, "error": str(e)[:300]}


# ── Read side ───────────────────────────────────────────────────

def impact_summary() -> dict:
    """Counts by action type and status, plus post-window aggregates.

    OBSERVATIONAL. Every figure is what happened after the action, not what the
    action caused: there is no control group, actions overlap, and the account
    moves for reasons unrelated to any single card. Ranking action types by
    these numbers is a hypothesis generator, not evidence.
    """
    out: dict = {
        "available": False,
        "caveat": ("Observational only — no control group, overlapping actions, "
                   "and account-wide drift are not separated. Not causal proof."),
        "by_type": {}, "totals": {}, "horizons": {},
    }
    try:
        from src.db import get_client
        client = get_client()

        decisions = (client.table(DECISIONS_TABLE)
                     .select("id,action_type,status,as_of_date,impact_estimate")
                     .execute().data) or []
        out["available"] = True

        by_type: dict[str, dict] = defaultdict(
            lambda: {"open": 0, "applied": 0, "dismissed": 0, "expired": 0,
                     "total": 0, "impact_estimate": 0.0})
        for d in decisions:
            b = by_type[d.get("action_type") or "unknown"]
            st = d.get("status") or "open"
            if st in b:
                b[st] += 1
            b["total"] += 1
            b["impact_estimate"] += float(d.get("impact_estimate") or 0)
        for b in by_type.values():
            b["impact_estimate"] = round(b["impact_estimate"], 2)

        outcomes = (client.table(OUTCOMES_TABLE)
                    .select("decision_id,horizon_days,spend,ad_sales,acos,orders,"
                            "contribution,account_spend")
                    .execute().data) or []
        d_by_id = {d["id"]: d for d in decisions}

        horizons: dict[str, dict] = defaultdict(
            lambda: defaultdict(lambda: {"n": 0, "spend": 0.0, "ad_sales": 0.0, "orders": 0}))
        for o in outcomes:
            d = d_by_id.get(o["decision_id"])
            if not d:
                continue
            key = f"{o['horizon_days']}d"
            bucket = horizons[key][d.get("status") or "open"]
            bucket["n"] += 1
            bucket["spend"] += float(o.get("spend") or 0)
            bucket["ad_sales"] += float(o.get("ad_sales") or 0)
            bucket["orders"] += int(o.get("orders") or 0)

        shaped: dict[str, dict] = {}
        for h, statuses in horizons.items():
            shaped[h] = {}
            for st, v in statuses.items():
                shaped[h][st] = {
                    "n": v["n"],
                    "spend": round(v["spend"], 2),
                    "ad_sales": round(v["ad_sales"], 2),
                    "orders": v["orders"],
                    "acos": round(v["spend"] / v["ad_sales"] * 100, 1) if v["ad_sales"] > 0 else None,
                }

        out["by_type"] = dict(by_type)
        out["horizons"] = shaped
        out["totals"] = {
            "decisions": len(decisions),
            "outcomes": len(outcomes),
            "applied": sum(1 for d in decisions if d.get("status") == "applied"),
            "dismissed": sum(1 for d in decisions if d.get("status") == "dismissed"),
            "open": sum(1 for d in decisions if (d.get("status") or "open") == "open"),
        }
        return out
    except Exception as e:
        if _missing_table(e, DECISIONS_TABLE) or _missing_table(e, OUTCOMES_TABLE):
            out["note"] = "Learning tables not present — run supabase/migration_ads_learning.sql"
            return out
        out["error"] = str(e)[:200]
        return out
