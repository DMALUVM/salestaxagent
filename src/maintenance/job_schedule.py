"""Cron specs for jobs registered in `src.main.run`.

The 07:20 health check derives each freshness window from these specs:
the latest meaningful `job_runs` row must cover the most recent fire
that is already past that job's misfire grace.

Hours below match `scheduler.add_job` in `src/main.py`. Where the
scheduler reads a config file (health check-in, git auto-update, SQP,
SoldScope), this module reads the same file. A drift test fails if a
new string `id=` appears in `run()` and is neither listed here nor
named in `EXCLUDED_SCHEDULER_IDS`.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# APScheduler's default when add_job omits misfire_grace_time.
DEFAULT_MISFIRE_GRACE_SECONDS = 1

# Standing scheduler ids that do not get a job_runs freshness check.
# heartbeat / source monitor / github backup / the job worker never
# write job_runs. The startup git pass is a one-shot date trigger; the
# 04:30 cron is the row we judge.
EXCLUDED_SCHEDULER_IDS: dict[str, str] = {
    "heartbeat": "stamps logs/heartbeat.json; no job_runs row",
    "source_monitoring": "does not write job_runs",
    "github_backup": "does not write job_runs",
    "job_worker": "polls agent_jobs; no job_runs row",
    "git_auto_update_startup": "one-shot date trigger; cron git_auto_update is the check",
}

_ROOT = Path(__file__).resolve().parent.parent.parent
_DOW = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


@dataclass(frozen=True)
class JobSpec:
    """One scheduled job the health check may require a fresh success for."""

    name: str
    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    dows: tuple[int, ...] | None
    timezone: str
    misfire_grace_seconds: int
    gate: str | None = None
    interval_seconds: int | None = None

    @property
    def records_job_runs(self) -> bool:
        return True


def _dow(value) -> tuple[int, ...] | None:
    if value is None:
        return None
    parts = [p.strip().lower() for p in str(value).split(",") if p.strip()]
    out = []
    for part in parts:
        if part in _DOW:
            out.append(_DOW[part])
        else:
            out.append(int(part))
    return tuple(out)


def _hours(value) -> tuple[int, ...]:
    if isinstance(value, int):
        return (value,)
    return tuple(int(p.strip()) for p in str(value).split(",") if p.strip())


def _daily(
    name: str,
    hour: int | str,
    minute: int,
    *,
    grace: int = DEFAULT_MISFIRE_GRACE_SECONDS,
    gate: str | None = None,
    tz: str,
    dow=None,
) -> JobSpec:
    return JobSpec(
        name=name,
        minutes=(int(minute),),
        hours=_hours(hour),
        dows=_dow(dow),
        timezone=tz,
        misfire_grace_seconds=int(grace),
        gate=gate,
    )


def _read_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def load_job_specs(
    *,
    agent_tz: str,
    health_hour: int,
    health_minute: int,
    health_tz: str,
    git_hour: int,
    git_minute: int,
    shopify_poll_hours: int,
    sqp_schedule: dict | None,
    soldscope_weekly: dict,
    soldscope_rt: dict,
    competitor_schedule: dict,
) -> list[JobSpec]:
    """Build the standing schedule. Callers filter on `gate`."""
    tz = agent_tz
    sqp = sqp_schedule or {}
    weekly = soldscope_weekly or {}
    rt = soldscope_rt or {}
    comp = competitor_schedule or {}
    poll_hours = max(1, int(shopify_poll_hours or 1))
    # Interval jobs do not set misfire_grace. One late tick is not an
    # outage; two missed intervals is. Window = interval + grace.
    poll_seconds = poll_hours * 3600

    specs = [
        _daily("health_ping", health_hour, health_minute, grace=3600, tz=health_tz),
        _daily("daily_analysis", 8, 0, tz=tz),
        _daily("deadline_check", 9, 0, tz=tz),
        _daily("paid_ads_freshness", 7, 15, tz=tz, dow="mon"),
        _daily("cpa_exports", 6, 30, tz=tz),
        _daily("ppc_export_publish", 7, 30, grace=3600, tz=tz),
        _daily("3pl_sync", 6, 35, tz=tz),
        _daily("pnl_sync", 6, 45, grace=3600, tz=tz),
        _daily("ads_outcomes", 7, 0, grace=3600, tz=tz),
        _daily(
            "soldscope_weekly_sync",
            int(weekly.get("hour", 10)),
            int(weekly.get("minute", 30)),
            grace=7200,
            tz=str(weekly.get("timezone") or tz),
            dow=weekly.get("day_of_week", "sun"),
        ),
        _daily(
            "soldscope_daily_rt",
            int(rt.get("hour", 6)),
            int(rt.get("minute", 15)),
            grace=7200,
            tz=str(rt.get("timezone") or tz),
        ),
        _daily(
            "soldscope_competitor_kr_sync",
            int(comp.get("hour", 10)),
            int(comp.get("minute", 45)),
            grace=7200,
            tz=str(comp.get("timezone") or tz),
            dow=comp.get("day_of_week", "sun"),
        ),
        JobSpec(
            name="shopify_poll",
            minutes=(),
            hours=(),
            dows=None,
            timezone=tz,
            misfire_grace_seconds=poll_seconds,
            gate="shopify",
            interval_seconds=poll_seconds,
        ),
        _daily("shopify_funnel_sync", 7, 15, grace=3600, gate="shopify", tz=tz),
        _daily("spapi_refresh", 6, 0, gate="amazon_sp", tz=tz),
        _daily("amazon_sku_month", 6, 20, grace=3600, gate="amazon_sp", tz=tz),
        _daily(
            "inventory_ledger_backfill", 4, 0, grace=7200,
            gate="amazon_sp", tz=tz, dow="sun",
        ),
        _daily("inventory_sync", 6, 30, gate="amazon_sp", tz=tz),
        _daily("ledger_summary_daily", 6, 40, grace=3600, gate="amazon_sp", tz=tz),
        _daily(
            "sqp_sync",
            int(sqp.get("hour", 10)),
            int(sqp.get("minute", 0)),
            grace=21600,
            gate="sqp",
            tz=str(sqp.get("timezone") or "America/Los_Angeles"),
            dow=sqp.get("day_of_week", "mon"),
        ),
        _daily("ads_campaigns_sync", 5, 0, grace=3600, gate="amazon_ads", tz=tz),
        _daily("ads_search_terms_sync", 5, 30, grace=3600, gate="amazon_ads", tz=tz),
        _daily("ads_sb_sd_heal", 13, 0, grace=3600, gate="amazon_ads", tz=tz),
        _daily("ads_prior_day_gate", 6, 20, grace=3600, gate="amazon_ads", tz=tz),
        _daily("ads_actions", 6, 0, grace=3600, gate="amazon_ads", tz=tz),
        _daily(
            "ads_campaigns_backfill", 3, 0, grace=7200,
            gate="amazon_ads", tz=tz, dow="sun",
        ),
        _daily(
            "ads_search_terms_backfill", 3, 30, grace=7200,
            gate="amazon_ads", tz=tz, dow="sun",
        ),
        _daily("ads_placements_sync", 5, 15, grace=3600, gate="amazon_ads", tz=tz),
        _daily(
            "ads_gno_campaigns_sync", "1,9,13,17,21", 0,
            grace=1800, gate="amazon_ads", tz=tz,
        ),
        _daily("ga4_sync", 7, 20, grace=3600, gate="ga4", tz=tz),
        _daily("gsc_sync", 7, 25, grace=3600, gate="gsc", tz=tz),
        _daily("google_ads_sync", 7, 30, grace=3600, gate="google_ads", tz=tz),
        _daily("meta_ads_sync", 7, 35, grace=3600, gate="meta_ads", tz=tz),
        _daily("git_auto_update", git_hour, git_minute, grace=3600, gate="git", tz=tz),
    ]
    names = [s.name for s in specs]
    if len(names) != len(set(names)):
        raise RuntimeError(f"duplicate job spec: {names}")
    overlap = set(names) & set(EXCLUDED_SCHEDULER_IDS)
    if overlap:
        raise RuntimeError(f"job both checked and excluded: {sorted(overlap)}")
    return specs


def sqp_schedule_enabled() -> bool:
    """Same switch `run()` uses before it registers sqp_sync."""
    strategy = _read_json(_ROOT / "config" / "ads_strategy.json")
    gating = strategy.get("organic_rank_gating") or {}
    return bool((gating.get("sqp_auto") or {}).get("enabled"))


def build_job_specs() -> list[JobSpec]:
    """Specs from the same config the scheduler uses, plus the inline crons."""
    from src.maintenance.git_auto_update import CRON_HOUR, CRON_MINUTE
    from src.rules import AGENT_TZ_NAME

    health = _read_json(_ROOT / "config" / "health.json")["schedule"]
    strategy = _read_json(_ROOT / "config" / "ads_strategy.json")
    gating = strategy.get("organic_rank_gating") or {}
    sqp = ((gating.get("sqp_auto") or {}).get("schedule") or {})
    sold = _read_json(_ROOT / "config" / "soldscope.json")
    comp = _read_json(_ROOT / "config" / "soldscope_competitors.json")
    try:
        from src.config import settings
        poll_hours = int(settings.shopify_poll_interval_hours)
    except Exception:
        poll_hours = 2

    return load_job_specs(
        agent_tz=AGENT_TZ_NAME,
        health_hour=int(health["hour"]),
        health_minute=int(health["minute"]),
        health_tz=str(health.get("timezone") or AGENT_TZ_NAME),
        git_hour=int(CRON_HOUR),
        git_minute=int(CRON_MINUTE),
        shopify_poll_hours=poll_hours,
        sqp_schedule=sqp,
        soldscope_weekly=sold.get("schedule") or {},
        soldscope_rt=(sold.get("rank_tracker") or {}).get("schedule") or {},
        competitor_schedule=comp.get("schedule") or {},
    )


def scheduled_names(specs: list[JobSpec], gates: dict[str, bool]) -> list[str]:
    """Job names the running agent would have registered."""
    out = []
    for spec in specs:
        if spec.gate is None or gates.get(spec.gate):
            out.append(spec.name)
    return out


def _matches(spec: JobSpec, cursor: datetime) -> bool:
    if cursor.minute not in spec.minutes:
        return False
    if cursor.hour not in spec.hours:
        return False
    if spec.dows is not None and cursor.weekday() not in spec.dows:
        return False
    return True


def _previous_cron(spec: JobSpec, moment: datetime) -> datetime:
    """Latest cron fire at or before `moment` (same timezone, minute resolution)."""
    cursor = moment.replace(second=0, microsecond=0)
    # Eight days covers weekly jobs. +5 absorbs the inclusive current minute.
    for _ in range(8 * 24 * 60 + 5):
        if _matches(spec, cursor) and cursor <= moment:
            return cursor
        cursor -= timedelta(minutes=1)
    raise RuntimeError(f"no cron fire for {spec.name} within 8 days of {moment.isoformat()}")


def required_started_at(spec: JobSpec, now: datetime) -> datetime:
    """Earliest `started_at` that still satisfies this job's freshness window.

    While `now` is inside the misfire grace of the latest fire, the
    previous fire is the one that must already have succeeded. That keeps
    a 07:20 check from paging on a job scheduled at 07:20 or 07:35.
    """
    tz = ZoneInfo(spec.timezone)
    moment = now.astimezone(tz)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=tz)
    if spec.interval_seconds:
        window = spec.interval_seconds + spec.misfire_grace_seconds
        return moment - timedelta(seconds=window)
    last = _previous_cron(spec, moment)
    grace = timedelta(seconds=spec.misfire_grace_seconds)
    if moment < last + grace:
        last = _previous_cron(spec, last - timedelta(seconds=1))
    return last
