"""Per-jurisdiction matrix of non-sales-tax obligations for a remote seller.

Answers "what, other than a sales-tax return, might this state want from an
FBA/Shopify seller?" for all 50 states plus DC.

The design point is the third status. A jurisdiction is `verified_applies` (an
obligation was checked against an official source), `verified_none` (checked,
and nothing arises), or `not_researched` — and `not_researched` is NOT a
finding of "nothing required". Collapsing those two would turn 38 unexamined
states into a clean bill of health, which is the single most dangerous thing
this file could say.
"""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

MATRIX_PATH = Path(__file__).resolve().parents[2] / "config" / "state_entity_matrix.json"

STATUSES = ("verified_applies", "verified_none", "not_researched")
MODES = ("schedulable", "review_only")

# Triggers that do NOT follow from selling remotely into a state. An obligation
# with this trigger exists only because the entity registered with that state's
# Secretary of State — registering to collect sales tax never creates one.
QUALIFICATION_TRIGGER = "qualification"


@dataclass
class MatrixObligation:
    state_code: str
    name: str
    trigger: str
    confidence: str
    source_url: str
    mode: str
    note: str
    rule_ref: str

    @property
    def is_review_only(self) -> bool:
        return self.mode == "review_only"

    @property
    def from_qualification_only(self) -> bool:
        return self.trigger == QUALIFICATION_TRIGGER


def load_matrix(path: Path | None = None) -> dict:
    with open(path or MATRIX_PATH) as f:
        return json.load(f)


def obligations(matrix: dict | None = None) -> list[MatrixObligation]:
    m = matrix or load_matrix()
    out = []
    for state, row in m["jurisdictions"].items():
        for o in row.get("obligations") or []:
            out.append(MatrixObligation(
                state_code=state, name=o["name"], trigger=o["trigger"],
                confidence=o["confidence"], source_url=o["source_url"],
                mode=o["mode"], note=o.get("note", ""),
                rule_ref=o.get("rule_ref", ""),
            ))
    return out


def counts(matrix: dict | None = None) -> dict:
    m = matrix or load_matrix()
    by_status = Counter(r["status"] for r in m["jurisdictions"].values())
    obs = obligations(m)
    return {
        "jurisdictions": len(m["jurisdictions"]),
        "by_status": {s: by_status.get(s, 0) for s in STATUSES},
        "obligations": len(obs),
        "by_mode": dict(Counter(o.mode for o in obs)),
        "by_trigger": dict(Counter(o.trigger for o in obs)),
        "by_confidence": dict(Counter(o.confidence for o in obs)),
    }


def states_with_status(status: str, matrix: dict | None = None) -> list[str]:
    m = matrix or load_matrix()
    return sorted(s for s, r in m["jurisdictions"].items() if r["status"] == status)


def remote_seller_exposure(matrix: dict | None = None) -> list[MatrixObligation]:
    """Obligations a remote seller can owe WITHOUT foreign-qualifying.

    The subset that actually matters when deciding where to look next: an
    annual report that only exists because you registered with a Secretary of
    State is not an exposure, it is a consequence of a choice already made.
    """
    return [o for o in obligations(matrix) if not o.from_qualification_only]
