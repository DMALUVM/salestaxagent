#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Sales Tax Agent repo.
# Prepares the Python CLI (venv + deps) and the Next.js dashboard (node_modules).
# Safe to run repeatedly: it converges on the same state and never starts a server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Python CLI: virtualenv + dependencies"
# ensurepip needs the python3-venv package on Debian/Ubuntu images.
if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "python3 venv module missing; expected the base image to provide python3-venv" >&2
  exit 1
fi

if [ ! -x "venv/bin/python" ]; then
  python3 -m venv venv
fi

./venv/bin/pip install --upgrade pip >/dev/null
# Runtime deps plus pytest (the mandated test runner; see CLAUDE.md).
./venv/bin/pip install -r requirements.txt pytest

echo "==> Dashboard: node dependencies"
cd dashboard
# Prefer a clean, lockfile-exact install; fall back to npm install if the
# lockfile and package.json drift (npm ci refuses to reconcile them).
if ! npm ci; then
  echo "npm ci failed (lockfile drift?); falling back to npm install" >&2
  npm install
fi

echo "==> Install complete"
