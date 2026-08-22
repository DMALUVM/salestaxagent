"""Apply/dismiss wiring — the path ads-mark and the dashboard must share.

Nothing here writes to Amazon. We pin the decision payload and the two-table
update order so a future change cannot silently drop the decision log (the
bug that left 347 decisions open and 0 outcomes).
"""
from datetime import datetime, timezone
from src.amazon_ads.learning import (
    decision_patch, mark_decision, mark_recommendation, resolve_decision_id,
)


class TestDecisionPatch:
    def test_applied_sets_applied_at(self):
        now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
        p = decision_patch("applied", now)
        assert p == {"status": "applied",
                     "applied_at": "2026-08-22T12:00:00+00:00"}

    def test_dismissed_sets_dismissed_at(self):
        now = datetime(2026, 8, 22, 12, 0, tzinfo=timezone.utc)
        p = decision_patch("dismissed", now)
        assert p["status"] == "dismissed" and "dismissed_at" in p
        assert "applied_at" not in p

    def test_invalid_status_is_none(self):
        assert decision_patch("auto-apply") is None
        assert decision_patch("yes") is None

    def test_mark_decision_rejects_invalid_status_without_db(self):
        assert mark_decision("any-id", "auto-apply") is False


class _FakeExecute:
    def __init__(self, data=None, error=None):
        self.data = data
        self.error = error


class _FakeQuery:
    def __init__(self, store, table):
        self.store = store
        self.table = table
        self._op = None
        self._payload = None
        self._eq = {}

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        rows = self.store.setdefault(self.table, [])
        if self._op == "update":
            matched = 0
            for row in rows:
                if all(row.get(k) == v for k, v in self._eq.items()):
                    row.update(self._payload)
                    matched += 1
            self.store.setdefault("_updates", []).append(
                (self.table, dict(self._eq), dict(self._payload)))
            return _FakeExecute(data=[{"ok": True}] * matched)
        if self._op == "select":
            out = [r for r in rows
                   if all(r.get(k) == v for k, v in self._eq.items())]
            return _FakeExecute(data=out)
        return _FakeExecute(data=[])


class _FakeClient:
    def __init__(self):
        self.tables = {
            "ads_recommendations": [],
            "ads_action_decisions": [],
        }

    def table(self, name):
        return _FakeQuery(self.tables, name)


class TestMarkRecommendation:
    def test_updates_queue_and_decision(self):
        client = _FakeClient()
        rec = {"id": "rec-1", "type": "NEGATE_SEARCH_TERM",
               "entity_name": "chap stick", "campaign_id": "c1",
               "decision_id": "dec-1", "status": "open"}
        client.tables["ads_recommendations"].append(dict(rec))
        client.tables["ads_action_decisions"].append(
            {"id": "dec-1", "status": "open", "rec_type": rec["type"],
             "entity_name": rec["entity_name"], "campaign_id": rec["campaign_id"]})

        result = mark_recommendation(rec, "applied", client=client)
        assert result["ok"] is True
        assert result["decisionLogged"] is True
        assert result["decisionId"] == "dec-1"
        assert client.tables["ads_recommendations"][0]["status"] == "applied"
        dec = client.tables["ads_action_decisions"][0]
        assert dec["status"] == "applied"
        assert "applied_at" in dec

    def test_resolves_natural_key_when_decision_id_missing(self):
        client = _FakeClient()
        rec = {"id": "rec-2", "type": "REDUCE_BID",
               "entity_name": "tallow", "campaign_id": "c9",
               "decision_id": None, "status": "open"}
        client.tables["ads_recommendations"].append(dict(rec))
        client.tables["ads_action_decisions"].append(
            {"id": "dec-9", "status": "open", "rec_type": "REDUCE_BID",
             "entity_name": "tallow", "campaign_id": "c9",
             "as_of_date": "2026-08-20"})

        assert resolve_decision_id(rec, client=client) == "dec-9"
        result = mark_recommendation(rec, "dismissed", client=client)
        assert result["ok"] and result["decisionLogged"]
        assert client.tables["ads_action_decisions"][0]["status"] == "dismissed"

    def test_never_invents_a_status(self):
        client = _FakeClient()
        rec = {"id": "rec-3", "decision_id": "dec-3"}
        result = mark_recommendation(rec, "auto-apply", client=client)
        assert result["ok"] is False
        assert client.tables.get("_updates") in (None, [])

    def test_missing_rec_id_is_rejected(self):
        assert mark_recommendation({}, "applied")["ok"] is False


def test_ads_mark_cli_calls_mark_recommendation():
    from pathlib import Path
    src = Path("src/main.py").read_text()
    start = src.index('@cli.command("ads-mark")')
    chunk = src[start:start + 2500]
    assert "mark_recommendation" in chunk
    assert "from src.amazon_ads.learning import mark_recommendation" in chunk
    learning = Path("src/amazon_ads/learning.py").read_text()
    assert "Never writes to Amazon" in learning
    assert "def mark_recommendation" in learning
