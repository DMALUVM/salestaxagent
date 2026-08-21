"""Daily health check-in — one short Telegram message, or silence.

The operator should not have to run terminal commands to know the agent is
working. This answers "is it working?" once a day in a message short enough to
read on a lock screen, and stays quiet the rest of the time.

Three rules shape the whole module:

  **One routine message per calendar day.** A health monitor that pings hourly
  gets muted, and a muted monitor is worse than none — the one time it matters,
  nobody looks.

  **Debounce warnings, but never suppress news.** The same fault repeats at most
  once every 24h. A NEW fault, or the same fault at higher severity, sends
  immediately: a debounce window must never hide a situation getting worse.

  **Report figures or say "n/a" — never omit.** Every number comes from a
  database aggregate. A silently missing field reads as a healthy zero, so an
  unavailable figure is printed as "n/a" and the reason lands in the fault list.

The check-in carries a compact ads scoreboard as well as liveness, because
"the scheduler is running" is not the same as "the account is fine", and the
operator wants both in the single message they actually read.

Layering: collect() touches the database, everything below it is pure. The
formatting and debounce logic can therefore be tested without an account.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
_CONFIG_PATH = ROOT / "config" / "health.json"

OK, WARN, CRITICAL = "ok", "warn", "critical"
_SEVERITY_RANK = {OK: 0, WARN: 1, CRITICAL: 2}


def load_config() -> dict:
    with open(_CONFIG_PATH) as f:
        return json.load(f)


CONFIG = load_config()


def _state_path() -> Path:
    return ROOT / "logs" / "health_state.json"


def _heartbeat_path(cfg: dict | None = None) -> Path:
    return ROOT / (cfg or CONFIG)["heartbeat"]["path"]


# ── heartbeat ────────────────────────────────────────────────────────────

def write_heartbeat(cfg: dict | None = None) -> None:
    """Stamp the heartbeat. Called by the scheduler on a short interval.

    Deliberately a local file rather than a database row: the heartbeat has to
    stay writable when Supabase is exactly what is broken.
    """
    p = _heartbeat_path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    payload = {"at": datetime.now(timezone.utc).isoformat(), "pid": os.getpid()}
    tmp.write_text(json.dumps(payload))
    tmp.replace(p)          # atomic, so a reader never sees a half-written file


def read_heartbeat(cfg: dict | None = None) -> dict | None:
    try:
        return json.loads(_heartbeat_path(cfg).read_text())
    except Exception:
        return None


# ── facts ────────────────────────────────────────────────────────────────

def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def collect(cfg: dict | None = None, now: datetime | None = None) -> dict:
    """Gather every fact the check-in reports. The only DB-touching function.

    Never raises: an unreachable database is itself one of the things being
    monitored, so a failure here becomes a fact rather than a traceback.
    """
    cfg = cfg or CONFIG
    now = now or datetime.now(timezone.utc)
    win = int(cfg["scoreboard"]["window_days"])

    facts: dict = {
        "now": now.isoformat(), "db_ok": True, "db_error": None,
        "window_days": win, "timezone_note": "America/Los_Angeles closed days",
        "ads": None, "prior": None, "amazon_sales": None,
        "ads_last_sync": None, "ads_sync_age_hours": None, "ads_last_job": None,
        "ads_last_date": None, "ads_data_age_days": None,
        "sqp_last_week_end": None, "sqp_age_days": None,
        "sqp_span_weeks": None, "sqp_first_week": None,
        "open_p0": None, "auth_failures": [],
    }

    try:
        from src.db import get_client
        from src.rules import amazon_as_of, window_start

        client = get_client()
        asof = amazon_as_of()
        start = window_start(asof, win)
        prior_end = start - timedelta(days=1)
        prior_start = window_start(prior_end, win)
        facts["as_of"] = asof.isoformat()
        facts["window"] = f"{start.isoformat()} → {asof.isoformat()}"
        facts["prior_window"] = f"{prior_start.isoformat()} → {prior_end.isoformat()}"

        def ads_window(a, b) -> dict:
            agg = {"spend": 0.0, "sales": 0.0, "orders": 0, "rows": 0}
            off = 0
            while True:
                p = (client.table("ads_campaigns_daily")
                     .select("date,campaign_id,spend,sales_14d,orders_14d")
                     .gte("date", str(a)).lte("date", str(b))
                     .order("date").order("campaign_id")
                     .range(off, off + 999).execute().data) or []
                for r in p:
                    agg["spend"] += _num(r.get("spend"))
                    agg["sales"] += _num(r.get("sales_14d"))
                    agg["orders"] += int(r.get("orders_14d") or 0)
                agg["rows"] += len(p)
                if len(p) < 1000:
                    break
                off += 1000
            return agg

        facts["ads"] = ads_window(start, asof)
        facts["prior"] = ads_window(prior_start, prior_end)

        # TACoS denominator. Absent sales must read "n/a", never as zero — a
        # zero denominator would silently drop TACoS from the message.
        try:
            total, off = 0.0, 0
            rows = 0
            while True:
                p = (client.table("sales_daily")
                     .select("sale_date,gross_sales,channel").eq("channel", "amazon")
                     .gte("sale_date", str(start)).lte("sale_date", str(asof))
                     .order("sale_date").range(off, off + 999).execute().data) or []
                total += sum(_num(x.get("gross_sales")) for x in p)
                rows += len(p)
                if len(p) < 1000:
                    break
                off += 1000
            facts["amazon_sales"] = total if rows else None
        except Exception as e:
            facts["amazon_sales"] = None
            facts["sales_error"] = str(e)[:120]

        # Last successful ads sync — same table and job list the dashboard and
        # the PPC brief read, so all three agree on "last sync".
        try:
            from src.amazon_ads.export_brief import ADS_JOBS
        except Exception:
            ADS_JOBS = ["ads_sync", "ads_campaigns_sync"]
        try:
            r = (client.table("job_runs").select("job_name,started_at,status")
                 .in_("job_name", ADS_JOBS).eq("status", "success")
                 .order("started_at", desc=True).limit(1).execute().data) or []
            if r:
                facts["ads_last_sync"] = r[0]["started_at"]
                facts["ads_last_job"] = r[0]["job_name"]
                facts["ads_sync_age_hours"] = _age_hours(r[0]["started_at"], now)
        except Exception as e:
            facts.setdefault("errors", []).append(f"job_runs: {str(e)[:80]}")

        # Auth failures, by NAME only — a stack trace in a phone notification is
        # noise, and the fix is always "re-authorise", never "read the trace".
        try:
            cutoff = (now - timedelta(
                hours=int(cfg["thresholds"]["auth_failure_lookback_hours"]))).isoformat()
            # The column is `message`, not `error_message`. Selecting a column
            # that does not exist makes PostgREST raise, and the except below
            # swallowed it — so this entire check silently never ran and auth
            # failures, one of the five failure modes this job exists to catch,
            # could never be reported. A regression test now pins the column.
            r = (client.table("job_runs")
                 .select("job_name,status,message,started_at")
                 .eq("status", "fail").gte("started_at", cutoff)
                 .order("started_at", desc=True).limit(50).execute().data) or []
            seen = set()
            for row in r:
                msg = (row.get("message") or "").lower()
                # Bare "auth" and "token" are too loose: the first live run of
                # this check flagged inventory_sync as an auth failure because
                # its ImportError names `auth_headers_with_retry`. Credential
                # rejection has specific signatures; an import error is a
                # different fault and belongs in the failed-jobs line.
                if any(k in msg for k in ("cannot import name", "importerror",
                                          "modulenotfound", "no module named")):
                    continue
                if any(k in msg for k in (
                        "401", "403", "unauthorized", "invalid_grant",
                        "invalid_token", "expired token", "token expired",
                        "access denied", "re-authorize", "reauthorize",
                        "authentication failed", "invalid client")):
                    name = str(row.get("job_name") or "?")
                    if name not in seen:
                        seen.add(name)
                        facts["auth_failures"].append(name)
        except Exception as e:
            # Recorded, not swallowed. A bare `pass` here is exactly what let a
            # wrong column name masquerade as "no auth failures found" — the
            # check reported healthy precisely because it was broken.
            facts.setdefault("check_errors", []).append(
                f"auth-failure check: {str(e)[:100]}")

        try:
            r = (client.table("ads_campaigns_daily").select("date")
                 .order("date", desc=True).limit(1).execute().data) or []
            if r:
                facts["ads_last_date"] = str(r[0]["date"])
                from datetime import date as _d
                facts["ads_data_age_days"] = (
                    asof - _d.fromisoformat(facts["ads_last_date"])).days
        except Exception:
            pass

        try:
            r = (client.table("sqp_weekly").select("week_end")
                 .order("week_end", desc=True).limit(1).execute().data) or []
            if r and r[0].get("week_end"):
                from datetime import date as _d
                facts["sqp_last_week_end"] = str(r[0]["week_end"])
                facts["sqp_age_days"] = (
                    asof - _d.fromisoformat(facts["sqp_last_week_end"])).days
            # SPAN, not a distinct count. Counting stored weeks exactly means
            # paginating 16k+ rows, which is far too heavy for a health ping.
            # Both ends are week_START so the arithmetic is a clean multiple of
            # 7; mixing week_start with week_end added a spurious extra week.
            first = (client.table("sqp_weekly").select("week_start")
                     .order("week_start").limit(1).execute().data) or []
            last = (client.table("sqp_weekly").select("week_start")
                    .order("week_start", desc=True).limit(1).execute().data) or []
            if first and last:
                from datetime import date as _d
                days = (_d.fromisoformat(str(last[0]["week_start"]))
                        - _d.fromisoformat(str(first[0]["week_start"]))).days
                facts["sqp_span_weeks"] = days // 7 + 1
                facts["sqp_first_week"] = str(first[0]["week_start"])
        except Exception:
            pass

        try:
            r = (client.table("ads_recommendations").select("id,priority,status")
                 .eq("priority", "P0").eq("status", "open")
                 .range(0, 999).execute().data) or []
            facts["open_p0"] = len(r)
        except Exception:
            pass

        # Failed jobs in the last 24h, by NAME only. Inherited from the retired
        # 08:05 digest, which was the only place a broken job was reported —
        # inventory_sync had been failing daily and nothing else said so.
        # Names, not messages: a traceback in a phone notification is noise.
        try:
            cutoff = (now - timedelta(hours=24)).isoformat()
            r = (client.table("job_runs").select("job_name,status,started_at")
                 .eq("status", "fail").gte("started_at", cutoff)
                 .order("started_at", desc=True).limit(50).execute().data) or []
            facts["failed_jobs"] = sorted({str(x.get("job_name")) for x in r})
        except Exception as e:
            facts.setdefault("check_errors", []).append(
                f"failed-jobs check: {str(e)[:100]}")

        # Month-to-date sales by channel, also inherited from the digest. One
        # line; the operator has had this figure daily and removing it silently
        # would be a regression chosen on their behalf.
        try:
            mtd_start = asof.replace(day=1)
            mtd: dict[str, float] = {}
            off = 0
            while True:
                p = (client.table("sales_daily").select("sale_date,gross_sales,channel")
                     .gte("sale_date", str(mtd_start)).lte("sale_date", str(asof))
                     .order("sale_date").range(off, off + 999).execute().data) or []
                for x in p:
                    ch = str(x.get("channel") or "other")
                    mtd[ch] = mtd.get(ch, 0.0) + _num(x.get("gross_sales"))
                if len(p) < 1000:
                    break
                off += 1000
            facts["mtd"] = mtd or None
            facts["mtd_start"] = mtd_start.isoformat()
        except Exception as e:
            facts.setdefault("check_errors", []).append(f"mtd check: {str(e)[:100]}")

    except Exception as e:
        facts["db_ok"] = False
        facts["db_error"] = str(e)[:160]

    hb = read_heartbeat(cfg)
    facts["heartbeat_at"] = hb.get("at") if hb else None
    facts["heartbeat_age_minutes"] = (
        _age_hours(hb["at"], now) * 60 if hb and hb.get("at") else None)
    return facts


def _age_hours(stamp: str, now: datetime) -> float | None:
    try:
        t = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return max(0.0, (now - t).total_seconds() / 3600.0)
    except Exception:
        return None


# ── evaluation ───────────────────────────────────────────────────────────

@dataclass
class Fault:
    key: str
    severity: str
    text: str          # one plain line, no traceback


@dataclass
class Health:
    faults: list[Fault] = field(default_factory=list)

    @property
    def severity(self) -> str:
        return max((f.severity for f in self.faults),
                   key=lambda s: _SEVERITY_RANK[s], default=OK)

    @property
    def healthy(self) -> bool:
        return not self.faults

    def signature(self) -> str:
        """Identity of the current fault SET, for debounce comparison."""
        return ",".join(sorted(f"{f.key}:{f.severity}" for f in self.faults)) or OK


def evaluate(facts: dict, cfg: dict | None = None) -> Health:
    """Turn facts into plain faults. Pure — no clock, no database."""
    cfg = cfg or CONFIG
    t = cfg["thresholds"]
    h = Health()

    if not facts.get("db_ok"):
        h.faults.append(Fault("db", CRITICAL,
                              f"Supabase unreachable ({facts.get('db_error') or 'no detail'})"))
        # Everything else was read from that database; reporting it as stale too
        # would be three alarms for one cause.
        return h

    age = facts.get("ads_sync_age_hours")
    limit = t["ads_sync_stale_hours"]
    if age is None:
        h.faults.append(Fault("ads_sync", WARN,
                              "No successful ads sync on record"))
    elif age > limit:
        h.faults.append(Fault("ads_sync", WARN if age < limit * 2 else CRITICAL,
                              f"Ads sync stale — last success {age:.0f}h ago "
                              f"(limit {limit}h)"))

    d_age = facts.get("ads_data_age_days")
    if d_age is not None and d_age > t["ads_data_stale_days"]:
        h.faults.append(Fault("ads_data", WARN,
                              f"Newest ads row is {d_age}d before the last closed "
                              f"day (limit {t['ads_data_stale_days']}d)"))

    s_age = facts.get("sqp_age_days")
    if s_age is None:
        h.faults.append(Fault("sqp", WARN, "No SQP weeks stored"))
    elif s_age > t["sqp_stale_days"]:
        h.faults.append(Fault("sqp", WARN,
                              f"SQP newest week {facts.get('sqp_last_week_end')} is "
                              f"{s_age}d old (limit {t['sqp_stale_days']}d)"))

    hb = facts.get("heartbeat_age_minutes")
    hb_limit = cfg["heartbeat"]["stale_after_minutes"]
    if hb is None:
        h.faults.append(Fault("heartbeat", CRITICAL,
                              "Scheduler heartbeat missing — is the agent running?"))
    elif hb > hb_limit:
        h.faults.append(Fault("heartbeat", CRITICAL,
                              f"Scheduler heartbeat stale — {hb:.0f}m since last beat "
                              f"(limit {hb_limit}m)"))

    for job in facts.get("auth_failures") or []:
        h.faults.append(Fault(f"auth:{job}", CRITICAL,
                              f"Auth failure on {job} — re-authorise"))

    # A check that could not run is not a check that passed.
    for err in facts.get("check_errors") or []:
        h.faults.append(Fault("check_broken", WARN,
                              f"A health check could not run — {err}"))

    if facts.get("amazon_sales") is None:
        h.faults.append(Fault("sales", WARN,
                              "Amazon sales rows missing — TACoS shows n/a"))

    failed = facts.get("failed_jobs") or []
    if failed:
        h.faults.append(Fault("failed_jobs", WARN,
                              f"Job(s) failed in 24h: {', '.join(failed)}"))
    return h


# ── formatting ───────────────────────────────────────────────────────────

def _money(v) -> str:
    return f"${v:,.0f}" if isinstance(v, (int, float)) else "n/a"


def _delta_pct(now: float, before: float) -> str:
    if not before:
        return "n/a"
    c = (now - before) / before * 100
    return f"{'+' if c >= 0 else ''}{c:.0f}%"


def scoreboard_lines(facts: dict) -> list[str]:
    """Compact ads scoreboard. Every figure is a DB aggregate or 'n/a'."""
    a, p = facts.get("ads") or {}, facts.get("prior") or {}
    spend, sales = a.get("spend"), a.get("sales")
    if not a.get("rows"):
        return [f"Ads {facts.get('window_days', 7)}d: no rows — sales n/a"]

    acos = (spend / sales * 100) if sales else None
    roas = (sales / spend) if spend else None
    amz = facts.get("amazon_sales")
    tacos = (spend / amz * 100) if amz else None

    out = [
        f"Ads {facts.get('window_days', 7)}d to {facts.get('as_of', '?')} (LA closed days):",
        f"  {_money(spend)} spend · {_money(sales)} sales · "
        f"ACOS {f'{acos:.1f}%' if acos else 'n/a'} · "
        f"ROAS {f'{roas:.2f}x' if roas else 'n/a'} · "
        f"TACoS {f'{tacos:.1f}%' if tacos else 'n/a'}",
    ]
    if p.get("rows"):
        p_acos = (p["spend"] / p["sales"] * 100) if p.get("sales") else None
        out.append(
            f"  vs prior 7d: spend {_delta_pct(spend, p['spend'])} · "
            f"sales {_delta_pct(sales, p['sales'])} · "
            f"ACOS {f'{p_acos:.1f}%' if p_acos else 'n/a'} → "
            f"{f'{acos:.1f}%' if acos else 'n/a'}")
    else:
        out.append("  vs prior 7d: no prior rows — n/a")
    return out


def format_message(facts: dict, health: Health) -> str:
    """One message. Healthy or degraded, the scoreboard is always included."""
    day = str(facts.get("now", ""))[:10]
    L: list[str] = []

    if health.healthy:
        L.append(f"✅ Sales Tax Agent OK — {day}")
    else:
        mark = "🚨" if health.severity == CRITICAL else "⚠️"
        L.append(f"{mark} Agent attention — {day}")
        L.append("")
        for f in health.faults:
            L.append(f"- {f.text}")
    L.append("")
    L += scoreboard_lines(facts)

    sync = facts.get("ads_sync_age_hours")
    L.append(f"Last ads sync: {str(facts.get('ads_last_sync') or 'never')[:16]}"
             + (f" ({sync:.0f}h)" if sync is not None else " (n/a)"))

    wk, wa = facts.get("sqp_last_week_end"), facts.get("sqp_age_days")
    L.append(f"SQP: newest week {wk or 'n/a'}"
             + (f" ({wa}d)" if wa is not None else "")
             + f" · SQP history {facts.get('sqp_span_weeks') if facts.get('sqp_span_weeks') is not None else 'n/a'}w")

    hb = facts.get("heartbeat_age_minutes")
    p0 = facts.get("open_p0")
    L.append(f"Playbook: {p0 if p0 is not None else 'n/a'} P0 open · "
             f"scheduler: {'running' if hb is not None and hb <= CONFIG['heartbeat']['stale_after_minutes'] else 'NOT beating'}"
             + (f" ({hb:.0f}m)" if hb is not None else ""))
    mtd = facts.get("mtd")
    if mtd:
        parts = " · ".join(f"{k} {_money(v)}" for k, v in sorted(mtd.items()))
        L.append(f"MTD from {facts.get('mtd_start')}: {parts} · "
                 f"total {_money(sum(mtd.values()))}")
    L.append(f"DB: {'ok' if facts.get('db_ok') else 'UNREACHABLE'}")
    return "\n".join(L)


# ── debounce ─────────────────────────────────────────────────────────────

def _load_state(path: Path | None = None) -> dict:
    try:
        return json.loads((path or _state_path()).read_text())
    except Exception:
        return {}


def _save_state(state: dict, path: Path | None = None) -> None:
    p = path or _state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=1))


def should_send(health: Health, now: datetime, state: dict,
                cfg: dict | None = None) -> tuple[bool, str]:
    """Decide whether this check-in goes out. Pure: state in, decision out.

    Returns (send, reason). The reason is logged so a suppressed message can
    always be explained after the fact.
    """
    cfg = cfg or CONFIG
    day = now.date().isoformat()

    if health.healthy:
        if state.get("last_routine_day") == day:
            return False, "routine check-in already sent today"
        return True, "daily routine check-in"

    sig = health.signature()
    last_sig = state.get("last_fault_signature")
    last_sev = state.get("last_fault_severity", OK)

    if sig != last_sig:
        return True, "fault set changed"
    if _SEVERITY_RANK[health.severity] > _SEVERITY_RANK.get(last_sev, 0):
        return True, "severity increased"

    age = _age_hours(state.get("last_fault_at") or "", now)
    window = cfg["debounce"]["repeat_warning_after_hours"]
    if age is None or age >= window:
        return True, f"same fault, {window}h debounce elapsed"
    return False, f"same fault re-alerted in {window - age:.0f}h"


def record_sent(health: Health, now: datetime, state: dict) -> dict:
    if health.healthy:
        state["last_routine_day"] = now.date().isoformat()
        state["last_fault_signature"] = None
        state["last_fault_severity"] = OK
    else:
        state["last_fault_signature"] = health.signature()
        state["last_fault_severity"] = health.severity
        state["last_fault_at"] = now.isoformat()
    state["last_message_at"] = now.isoformat()
    return state


# ── entry point ──────────────────────────────────────────────────────────

def muted() -> bool:
    """HEALTH_TELEGRAM=0 mutes delivery without disabling the check itself."""
    return os.environ.get("HEALTH_TELEGRAM", "1").strip() in ("0", "false", "no")


def run_health_ping(send: bool = False, now: datetime | None = None,
                    state_path: Path | None = None) -> dict:
    """Collect, evaluate, decide, and optionally deliver.

    In dry-run this never touches Telegram, so a missing TELEGRAM_* config is
    not an error — the point of --dry-run is to see the message.
    """
    now = now or datetime.now(timezone.utc)
    facts = collect(now=now)
    health = evaluate(facts)
    message = format_message(facts, health)
    state = _load_state(state_path)
    will_send, reason = should_send(health, now, state)

    result = {
        "message": message, "healthy": health.healthy,
        "severity": health.severity, "would_send": will_send, "reason": reason,
        "faults": [f.text for f in health.faults], "sent": False, "error": None,
        "muted": muted(),
    }

    if not send:
        return result
    if muted():
        result["reason"] = "muted by HEALTH_TELEGRAM=0"
        return result
    if not will_send:
        return result

    try:
        from src.alerts.telegram import send_telegram
        r = send_telegram(message, parse_mode="")
        result["sent"] = bool(r.get("sent"))
        result["error"] = r.get("error")
    except Exception as e:
        result["error"] = str(e)[:200]

    if result["sent"]:
        _save_state(record_sent(health, now, state), state_path)
    return result
