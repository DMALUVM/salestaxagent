#!/usr/bin/env python3
"""Jev triage for shopper funnel / abandoned-cart rows (Dashboard sync output).

stdin: {items:[...]} or list. Each item: step metrics, abandon cohort, or leak candidate.
stdout: {pursue, hold, skip, errors, ...} — pursue = show Dave / act; hold = watch; skip = noise.
Fail closed → hold. Never prints API keys. Does not mutate Shopify/theme.

Protocol reference / box experiment only. Production Jev runs on Vercel
(`/api/shopify-funnel/jev-triage`) with dashboard-project AI_GATEWAY_API_KEY.
Mini shopify-funnel-sync must not invoke this script or hold that key.

HELPER resolution (box experiments, no /workspace required):
  1. $JEV_EVALUATE if it points at a file
  2. repo/vercel-ai-gateway/bin/jev_evaluate.py
  3. <parent>/bin/jev_evaluate.py when this file lives in vercel-ai-gateway/pilots/
  4. /workspace/vercel-ai-gateway/bin/jev_evaluate.py (box fallback only)

Do not commit API keys or that tree's node_modules.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

PACE_SEC = 1.4

LEAK_Q = {
    "severity": {
        "type": "choice",
        "instructions": (
            "Tallowbourn Shopify conversion leak triage. "
            "P0 = sudden cliff or large $ abandon spike needing Dave/ops eyes now; "
            "P1 = meaningful drop-off worth Dashboard highlight; "
            "P2 = normal noise / seasonal / already known kit friction."
        ),
        "criteria": {
            "p0": "conversion cliff, checkout broken signal, or large $ abandon vs baseline",
            "p1": "clear step leak (e.g. ATC→checkout or checkout→purchase) worth acting on",
            "p2": "small move, noisy, or already explained",
        },
    },
    "step": {
        "type": "choice",
        "instructions": "Which funnel step is the primary leak for this row?",
        "criteria": {
            "session_to_pdp": "land but don't view product",
            "pdp_to_atc": "view product but don't add",
            "atc_to_checkout": "cart but don't start checkout",
            "checkout_to_purchase": "checkout started but don't buy",
            "post_purchase": "not a pre-purchase leak",
            "unclear": "can't tell from evidence",
        },
    },
    "needs_dave": {
        "type": "boolean",
        "instructions": "Does Dave need to see this on the lock screen / morning note (vs Dashboard-only)?",
    },
}

MODES = {"leak": LEAK_Q}
STATE_KEYS = (
    "mode", "period", "step", "metric", "baseline", "current", "delta_pct",
    "abandon_count", "abandon_value", "product", "handle", "device", "channel",
    "evidence", "notes",
)


def resolve_jev_helper() -> Path:
    env = (os.environ.get("JEV_EVALUATE") or "").strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    here = Path(__file__).resolve()
    candidates = [
        here.parents[1] / "vercel-ai-gateway" / "bin" / "jev_evaluate.py",
        here.parents[1] / "bin" / "jev_evaluate.py",
        Path("/workspace/vercel-ai-gateway/bin/jev_evaluate.py"),
    ]
    for cand in candidates:
        if cand.is_file():
            return cand
    raise FileNotFoundError(
        "jev_evaluate.py not found. Mini keeps a gitignored sidecar at "
        "repo/vercel-ai-gateway/ (or set JEV_EVALUATE)."
    )


def load_jev():
    helper = resolve_jev_helper()
    spec = importlib.util.spec_from_file_location("jev_evaluate", helper)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load jev helper: {helper}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def item_state(item: dict) -> str:
    parts = [f"{k}: {item.get(k)}" for k in STATE_KEYS if item.get(k) not in (None, "")]
    return "\n".join(parts) or json.dumps(item)[:2500]


def choice_of(ans: dict, key: str) -> str:
    a = ans.get(key) or {}
    return a.get("choice") or a.get("value") or ""


def bool_true(ans: dict, key: str, thr: float = 0.5) -> bool:
    a = ans.get(key) or {}
    return float(a.get("probability") or 0) >= thr


def _dump(pursue, hold, skip, errors) -> None:
    json.dump(
        {
            "pursue": pursue,
            "hold": hold,
            "skip": skip,
            "errors": errors,
            "pursue_n": len(pursue),
            "hold_n": len(hold),
            "skip_n": len(skip),
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


def main() -> None:
    try:
        raw = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        _dump([], [{"jev_error": str(e), "mode": "leak"}], [],
              [{"index": -1, "error": str(e)}])
        return
    items = raw if isinstance(raw, list) else (raw.get("items") or [])
    pace = float((raw.get("pace_sec") if isinstance(raw, dict) else None) or PACE_SEC)
    try:
        jev = load_jev()
    except Exception as e:
        hold = [{**(it if isinstance(it, dict) else {"notes": str(it)}),
                 "jev_error": str(e), "mode": "leak"} for it in items] or [
            {"jev_error": str(e), "mode": "leak"}]
        _dump([], hold, [], [{"index": -1, "error": str(e)}])
        return
    pursue, hold, skip, errors = [], [], [], []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            item = {"notes": str(item)}
        if i and pace > 0:
            time.sleep(pace)
        try:
            out = jev.evaluate(item_state(item), LEAK_Q)
            answers = out.get("answers") or {}
            row = {**item, "jev": answers, "mode": "leak"}
            sev = choice_of(answers, "severity") or "p2"
            row["severity"] = sev
            row["primary_step"] = choice_of(answers, "step")
            if sev == "p0" or (sev == "p1" and bool_true(answers, "needs_dave")):
                pursue.append(row)
            elif sev == "p2" and not bool_true(answers, "needs_dave"):
                skip.append(row)
            else:
                hold.append(row)
        except Exception as e:
            hold.append({**item, "jev_error": str(e), "mode": "leak"})
            errors.append({"index": i, "error": str(e)})
    _dump(pursue, hold, skip, errors)


if __name__ == "__main__":
    main()
