"""Freshness and coverage of the FBA inventory ledger.

Inventory location is not a nice-to-have here: physical nexus — and therefore
which states the user registers in — is driven by which fulfilment centres have
held stock. A ledger that quietly stopped updating, or an FC code that never got
mapped to a state, both show up as "no nexus" rather than as an error. This
module makes those two failure modes visible.

The staleness and unknown-FC computations are pure so they can be tested and so
the CLI, the digest and the dashboard all report the same numbers.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# The ledger is pulled daily. Two missed runs is the point where a registration
# decision could be made on data that is silently a week behind.
STALE_AFTER_HOURS = 36
CRITICAL_AFTER_HOURS = 72


@dataclass
class UnknownFC:
    fc_code: str
    events: int
    first_seen: str
    last_seen: str


@dataclass
class LedgerHealth:
    total_events: int = 0
    date_min: str | None = None
    date_max: str | None = None
    distinct_states: int = 0
    states: list[str] = field(default_factory=list)
    events_by_year: dict[str, int] = field(default_factory=dict)
    unknown_fcs: list[UnknownFC] = field(default_factory=list)
    unknown_event_count: int = 0
    last_success_at: str | None = None
    last_success_status: str | None = None
    hours_since_success: float | None = None
    sources: dict[str, int] = field(default_factory=dict)

    @property
    def is_stale(self) -> bool:
        """No successful sync recently — or none ever recorded."""
        if self.hours_since_success is None:
            return True
        return self.hours_since_success > STALE_AFTER_HOURS

    @property
    def is_critical(self) -> bool:
        if self.hours_since_success is None:
            return True
        return self.hours_since_success > CRITICAL_AFTER_HOURS

    @property
    def status(self) -> str:
        if self.is_critical:
            return "critical"
        if self.is_stale:
            return "stale"
        return "ok"


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def hours_since(ts: str | None, now: datetime) -> float | None:
    dt = _parse_ts(ts)
    if dt is None:
        return None
    return (now - dt).total_seconds() / 3600.0


def last_successful_sync(job_rows: list[dict],
                         job_names: tuple[str, ...] = ("spapi_refresh",)) -> dict | None:
    """Most recent successful run of the job that pulls the ledger.

    `partial` counts as a success for freshness: the SP-API refresh does orders
    and inventory in one job, and a partial run still wrote whatever inventory
    it got. Treating it as a failure would raise a stale warning about data that
    is actually current.
    """
    ok = [j for j in job_rows
          if j.get("job_name") in job_names
          and str(j.get("status") or "") in ("success", "partial")]
    if not ok:
        return None
    return max(ok, key=lambda j: str(j.get("started_at") or ""))


def build_health(events: list[dict], job_rows: list[dict],
                 now: datetime | None = None) -> LedgerHealth:
    """Summarise ledger coverage and freshness from raw rows."""
    ref = now or datetime.now(timezone.utc)
    h = LedgerHealth(total_events=len(events))

    dates: list[str] = []
    states: set[str] = set()
    by_year: dict[str, int] = defaultdict(int)
    sources: dict[str, int] = defaultdict(int)
    unknown: dict[str, dict] = {}

    for e in events:
        d = str(e.get("event_date") or "")
        if d:
            dates.append(d)
            by_year[d[:4]] += 1
        sc = e.get("state_code")
        if sc:
            states.add(str(sc))
        else:
            # No state means the FC code is not in config/fc_codes.json. These
            # events are invisible to the physical-nexus engine, so a state the
            # user actually stores inventory in can be missing entirely.
            fc = str(e.get("fc_code") or "(blank)")
            u = unknown.setdefault(fc, {"events": 0, "first": d or "9999-99-99",
                                        "last": d or "0000-00-00"})
            u["events"] += 1
            if d:
                u["first"] = min(u["first"], d)
                u["last"] = max(u["last"], d)
        src = e.get("source_file")
        if src:
            sources[str(src)] += 1

    h.date_min = min(dates) if dates else None
    h.date_max = max(dates) if dates else None
    h.states = sorted(states)
    h.distinct_states = len(states)
    h.events_by_year = dict(sorted(by_year.items()))
    h.sources = dict(sorted(sources.items(), key=lambda kv: -kv[1]))
    h.unknown_fcs = sorted(
        (UnknownFC(fc, v["events"], v["first"], v["last"]) for fc, v in unknown.items()),
        key=lambda u: -u.events,
    )
    h.unknown_event_count = sum(u.events for u in h.unknown_fcs)

    last = last_successful_sync(job_rows)
    if last:
        h.last_success_at = str(last.get("started_at") or "")
        h.last_success_status = str(last.get("status") or "")
        h.hours_since_success = hours_since(h.last_success_at, ref)

    return h


def staleness_line(h: LedgerHealth) -> str | None:
    """One Telegram line, or None when the feed is healthy.

    Silence on a healthy day is the point — a warning that appears every morning
    is one nobody reads on the morning it matters.
    """
    if h.status == "ok":
        return None
    if h.hours_since_success is None:
        return ("⚠️ FBA inventory ledger: no successful sync on record — "
                "physical-nexus states may be incomplete")
    age = int(h.hours_since_success)
    icon = "🚨" if h.is_critical else "⚠️"
    through = f", latest event {h.date_max}" if h.date_max else ""
    return (f"{icon} FBA inventory ledger stale: last sync {age}h ago{through} "
            f"— physical-nexus states may be out of date")


def current_warning() -> str | None:
    """Staleness line for the digest, or None when the feed is healthy.

    Reads the DB, so it lives here rather than in the pure digest module. Any
    failure returns None: a digest that cannot check inventory freshness should
    still send, and a false alarm is worse than a missing line.

    Only job_runs is read — not the 130k-row event table — because freshness is
    about when the sync last succeeded, and the digest runs every morning.
    """
    try:
        from datetime import datetime, timezone

        from src.db import fetch_all

        h = build_health([], fetch_all("job_runs"), datetime.now(timezone.utc))
        if h.status == "ok":
            return None
        return staleness_line(h)
    except Exception:
        return None
