#!/usr/bin/env python3
"""Copy compliance playbook JSON files from config/ into dashboard/content/
so they ship with the Next.js deployment on Vercel.

Usage:
    python scripts/sync_playbooks_to_dashboard.py
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "config" / "compliance_playbooks"
DST = ROOT / "dashboard" / "content" / "compliance_playbooks"


def main():
    DST.mkdir(parents=True, exist_ok=True)

    copied = 0
    for f in sorted(SRC.glob("*.json")):
        shutil.copy2(f, DST / f.name)
        copied += 1

    print(f"Synced {copied} playbook files: {SRC} → {DST}")


if __name__ == "__main__":
    main()
