#!/usr/bin/env bash
# One-time setup: Python env, front-end build, demo data, offline eval.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv backend/.venv
backend/.venv/bin/pip install -q --upgrade pip
backend/.venv/bin/pip install -q -r backend/requirements.txt
(cd frontend && npm install --no-audit --no-fund && npm run build)
(cd backend && SLICEBOT_ENGINE=offline .venv/bin/python -m slicebot.data.generate > /dev/null)
echo "Setup done. Start with ./run.sh"
