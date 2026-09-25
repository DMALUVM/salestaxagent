#!/usr/bin/env python3
"""Mac Mini failure-only health check. Silent on success.

Launchd runs this daily at 07:20 America/New_York. See
deploy/launchd/README.md for install steps and env vars.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.maintenance.healthcheck_wake import main

if __name__ == "__main__":
    raise SystemExit(main())
