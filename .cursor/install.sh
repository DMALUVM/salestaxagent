#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Sales Tax Agent repo.
# Prepares the Python CLI (venv + deps) and the Next.js dashboard (node_modules).
# Safe to run repeatedly: it converges on the same state and never starts a server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

create_venv() {
  # ensurepip (needed by `python3 -m venv`) ships in the python3-venv apt
  # package on Debian/Ubuntu. The stock Cloud Agent image does not include it,
  # so create the venv and, only if that fails for the ensurepip reason,
  # install the version-matched package and retry once.
  local err
  err="$(python3 -m venv venv 2>&1)" && return 0
  echo "$err" >&2
  if echo "$err" | grep -qiE 'ensurepip|python3-venv'; then
    local pyver
    pyver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    echo "==> Installing python${pyver}-venv (ensurepip missing)"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "python${pyver}-venv" || sudo apt-get install -y -qq python3-venv
    rm -rf venv
    python3 -m venv venv
    return 0
  fi
  return 1
}

echo "==> Python CLI: virtualenv + dependencies"
if [ ! -x "venv/bin/python" ]; then
  create_venv
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

echo "==> Dashboard: production build (typecheck)"
npm run build

echo "==> Install complete"
