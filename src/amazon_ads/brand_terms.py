"""Branded vs non-branded classification for search queries.

Mirrors the BRAND TERMS sheet of the manual Branded Market Share Tracker, so
the automated rollups and the operator's spreadsheet agree on what "branded"
means.

Matching is deliberately conservative. Naive substring matching would classify
"beef tallow lip balm" as branded because "tallow" appears in "tallowbourn",
which would inflate branded share and — worse — make the PPC gate cap bid
increases on exactly the generic head terms we want to compete for. So:

  - `phrases` match as whole-word sequences, word-boundary anchored
  - `tokens` match a single whole token
  - generic components ("tallow", "dave", "primal", "essence") are listed in the
    config's _deliberately_excluded block as documentation of that decision

A false negative costs a capped bid we could have raised. A false positive
costs us the whole non-brand growth channel. The asymmetry is why this errs
toward non-branded.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "brand_terms.json"


def normalize(text: str | None) -> str:
    """Lowercase, collapse whitespace, strip most punctuation.

    Apostrophes and periods are folded to spaces so "dr. dave's" and
    "dr daves" reach the same normalised form and one rule covers both.
    """
    if not text:
        return ""
    s = str(text).lower()
    s = re.sub(r"[’'`.]", " ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


@dataclass(frozen=True)
class BrandRules:
    phrases: tuple[str, ...]
    tokens: frozenset[str]

    def match(self, query: str) -> str | None:
        """The rule that made this branded, or None."""
        q = normalize(query)
        if not q:
            return None
        parts = q.split(" ")
        token_set = set(parts)
        for t in self.tokens:
            if t in token_set:
                return t
        # Whole-word sequence: compare against the token list, not the raw
        # string, so "dr davenport" cannot match the phrase "dr dave".
        for p in self.phrases:
            pt = p.split(" ")
            n = len(pt)
            if n and any(parts[i:i + n] == pt for i in range(len(parts) - n + 1)):
                return p
        return None


@lru_cache(maxsize=1)
def load_rules(path: str | None = None) -> BrandRules:
    p = Path(path) if path else CONFIG_PATH
    try:
        doc = json.loads(p.read_text())
    except FileNotFoundError:
        return BrandRules(phrases=(), tokens=frozenset())
    phrases = tuple(sorted(
        {normalize(x) for x in (doc.get("phrases") or []) if normalize(x)},
        key=lambda s: -len(s)))          # longest first, for clearer attribution
    tokens = frozenset(normalize(x) for x in (doc.get("tokens") or []) if normalize(x))
    # A multi-word "token" is really a phrase; fold it rather than never matching.
    real_tokens = frozenset(t for t in tokens if " " not in t)
    extra_phrases = tuple(t for t in tokens if " " in t)
    return BrandRules(phrases=tuple(sorted(set(phrases + extra_phrases),
                                           key=lambda s: -len(s))),
                      tokens=real_tokens)


def is_branded(query: str, rules: BrandRules | None = None) -> bool:
    return (rules or load_rules()).match(query) is not None


def classify(query: str, rules: BrandRules | None = None) -> dict:
    """Full classification result, for storage and audit."""
    r = rules or load_rules()
    hit = r.match(query)
    return {"query": query, "normalized": normalize(query),
            "branded": hit is not None, "matched_rule": hit}


# ── Brand rename history ────────────────────────────────────────
#
# The brand was renamed around 2025-10-31 ("Dr. Dave's Primal Essence" ->
# "Tallowbourn") on the SAME ASINs. Both eras' terms count as branded, so mix
# and share stay continuous across the boundary: treating only the current name
# as brand would render the rename as a collapse in brand demand followed by a
# surge in "non-brand" purchases that were never non-brand.

@lru_cache(maxsize=1)
def brand_history(path: str | None = None) -> dict:
    p = Path(path) if path else CONFIG_PATH
    try:
        return json.loads(p.read_text()).get("brand_history") or {}
    except FileNotFoundError:
        return {}


def era_of(query: str) -> str | None:
    """'current' | 'legacy' | None — which brand era a branded query belongs to.

    Attribution only; both eras gate identically. Useful for reading a mix
    trend across the rename without mistaking it for a demand shift.
    """
    hist = brand_history()
    eras = hist.get("eras") or {}
    q = normalize(query)
    if not q:
        return None
    parts = q.split(" ")
    for era in ("current", "legacy"):
        for term in eras.get(era) or []:
            t = normalize(term)
            if not t:
                continue
            tp = t.split(" ")
            n = len(tp)
            if n == 1:
                if t in set(parts):
                    return era
            elif any(parts[i:i + n] == tp for i in range(len(parts) - n + 1)):
                return era
    return None
