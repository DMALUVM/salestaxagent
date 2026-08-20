"""Job-failure reporting: one line per broken job, nothing for recovered ones."""
from src.alerts.job_health import (
    JobFailure, current_failures, is_interruption, render_failures,
)

SINCE = "2026-08-19T00:00:00"


def run(name, status, at, message=""):
    return {"job_name": name, "status": status, "started_at": at, "message": message}


class TestRecovery:
    def test_recovered_job_is_not_reported(self):
        """The live case: ads_actions failed at 10:00, succeeded at 10:06."""
        rows = [
            run("ads_actions", "fail", "2026-08-20T10:00:00", "duplicate key ..."),
            run("ads_actions", "success", "2026-08-20T10:06:00", "79 recs"),
        ]
        assert current_failures(rows, SINCE) == []

    def test_still_broken_job_is_reported_once(self):
        rows = [
            run("inventory_sync", "fail", "2026-08-19T10:30:00", "ImportError"),
            run("inventory_sync", "fail", "2026-08-20T10:30:00", "ImportError"),
        ]
        f = current_failures(rows, SINCE)
        assert len(f) == 1
        assert f[0].job_name == "inventory_sync"
        assert f[0].count == 2

    def test_one_incident_is_not_listed_three_ways(self):
        rows = [run("ads_sync", "fail", f"2026-08-20T0{i}:00:00", "chunk error")
                for i in range(1, 4)]
        f = current_failures(rows, SINCE)
        assert len(f) == 1 and f[0].count == 3

    def test_a_running_job_does_not_mask_the_last_settled_failure(self):
        rows = [
            run("ads_sync", "fail", "2026-08-20T10:00:00", "boom"),
            run("ads_sync", "running", "2026-08-20T11:00:00"),
        ]
        assert [f.job_name for f in current_failures(rows, SINCE)] == ["ads_sync"]

    def test_a_job_with_only_running_rows_is_not_a_failure(self):
        assert current_failures([run("x", "running", "2026-08-20T10:00:00")], SINCE) == []


class TestNonFailures:
    def test_partial_is_not_a_failure(self):
        """Partial ads syncs describe their own shortfall; not a nightly push."""
        rows = [run("ads_campaigns_sync", "partial", "2026-08-20T12:44:00",
                    "SD FAILED, SP kept")]
        assert current_failures(rows, SINCE) == []

    def test_success_is_not_a_failure(self):
        assert current_failures([run("x", "success", "2026-08-20T10:00:00")], SINCE) == []

    def test_rows_outside_the_window_are_ignored(self):
        rows = [run("old_job", "fail", "2026-08-01T10:00:00", "boom")]
        assert current_failures(rows, SINCE) == []


class TestInterruptions:
    def test_restart_message_is_flagged_not_counted_as_breakage(self):
        rows = [run("ads_sync", "fail", "2026-08-20T18:50:00",
                    "Interrupted by agent restart (loading the new ads schedule).")]
        f = current_failures(rows, SINCE)
        assert len(f) == 1 and f[0].interrupted is True
        out = "\n".join(render_failures(f))
        assert "Failed Jobs" not in out
        assert "stopped by a restart" in out

    def test_marker_matching_is_case_insensitive(self):
        assert is_interruption("KeyboardInterrupt during sync")
        assert not is_interruption("connection reset by peer")

    def test_real_breakage_sorts_above_interruptions(self):
        rows = [
            run("a_job", "fail", "2026-08-20T10:00:00", "Interrupted by agent restart"),
            run("z_job", "fail", "2026-08-20T10:00:00", "ImportError"),
        ]
        assert [f.job_name for f in current_failures(rows, SINCE)] == ["z_job", "a_job"]


class TestRender:
    def test_all_healthy_renders_nothing(self):
        assert render_failures([]) == []

    def test_repeat_count_is_shown(self):
        f = [JobFailure("inventory_sync", "ImportError", "2026-08-20T10:30:00", 3, False)]
        assert "×3" in "\n".join(render_failures(f))

    def test_list_is_capped(self):
        f = [JobFailure(f"job{i}", "boom", "2026-08-20T10:00:00", 1, False)
             for i in range(9)]
        out = "\n".join(render_failures(f, limit=5))
        assert "+4 more" in out
