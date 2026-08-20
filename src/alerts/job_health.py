"""Which job failures are worth telling a human about.

Pure functions over job_runs rows. The digest used to list every `fail` row in
the last 24 hours, which meant one incident showed up repeatedly and, worse,
failures that a later run had already recovered kept being reported as if the
system were still broken. A list that is usually wrong is a list people stop
reading, which is how a real failure gets missed.

A failure is reported only when it is still the job's current state.
"""
from __future__ import annotations

from dataclasses import dataclass

# Messages that mean "this run was stopped", not "this job is broken".
# A deploy or scheduler reload kills in-flight runs; counting those as product
# failures makes every restart look like an outage.
INTERRUPTION_MARKERS = (
    "interrupted by agent restart",
    "interrupted by restart",
    "keyboardinterrupt",
    "systemexit",
    "shutting down",
)

# Statuses that are not a failure to report. `partial` is deliberately here:
# it means some data landed and the shortfall is already described in the run
# message (e.g. an ad product that timed out), so it is a status to read on the
# dashboard, not a nightly push.
NON_FAILURE_STATUSES = frozenset({"success", "running", "partial", "cancelled"})


@dataclass
class JobFailure:
    job_name: str
    message: str
    started_at: str
    count: int          # failures for this job inside the window
    interrupted: bool   # stopped by a restart rather than genuinely broken


def is_interruption(message: str | None) -> bool:
    m = (message or "").lower()
    return any(marker in m for marker in INTERRUPTION_MARKERS)


def current_failures(job_rows: list[dict], since_iso: str) -> list[JobFailure]:
    """Job failures that are still the job's latest outcome.

    One entry per job name, never one per incident. A job whose most recent
    run succeeded is considered recovered and is omitted entirely, however
    many times it failed earlier in the window.
    """
    recent = [j for j in job_rows if (j.get("started_at") or "") > since_iso]

    by_job: dict[str, list[dict]] = {}
    for j in recent:
        name = j.get("job_name")
        if name:
            by_job.setdefault(name, []).append(j)

    out: list[JobFailure] = []
    for name, runs in by_job.items():
        runs.sort(key=lambda r: r.get("started_at") or "")

        # `running` says nothing about health — a job in flight has not failed,
        # and judging by it would flap. Look at the last settled run.
        settled = [r for r in runs if (r.get("status") or "") != "running"]
        if not settled:
            continue

        latest = settled[-1]
        if (latest.get("status") or "") in NON_FAILURE_STATUSES:
            continue  # recovered, or never a failure

        failures = [r for r in settled if (r.get("status") or "") not in NON_FAILURE_STATUSES]
        out.append(JobFailure(
            job_name=name,
            message=str(latest.get("message") or "unknown"),
            started_at=str(latest.get("started_at") or ""),
            count=len(failures),
            interrupted=is_interruption(latest.get("message")),
        ))

    # Genuine breakage first; restart casualties are informational.
    out.sort(key=lambda f: (f.interrupted, f.job_name))
    return out


def render_failures(failures: list[JobFailure], limit: int = 5) -> list[str]:
    """Telegram lines for the failures worth showing. Empty when all is well."""
    real = [f for f in failures if not f.interrupted]
    interrupted = [f for f in failures if f.interrupted]

    parts: list[str] = []
    if real:
        parts.append("")
        parts.append("<b>Failed Jobs (24h):</b>")
        for f in real[:limit]:
            repeat = f" ×{f.count}" if f.count > 1 else ""
            parts.append(f"  ❌ {f.job_name}{repeat}: {f.message[:90]}")
        if len(real) > limit:
            parts.append(f"  +{len(real) - limit} more")

    if interrupted:
        names = ", ".join(f.job_name for f in interrupted[:4])
        parts.append(f"<i>({len(interrupted)} job(s) stopped by a restart, not a "
                     f"failure: {names})</i>")

    return parts
