#!/usr/bin/env bash
# Starts the console at http://127.0.0.1:8787
# Live Claude mode: put ANTHROPIC_API_KEY in .env (see .env.example) or export it first.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
cd backend
echo "SliceBot console: http://127.0.0.1:8787  (engine: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo Claude || echo rules))"
exec .venv/bin/uvicorn slicebot.api:app --host 127.0.0.1 --port 8787
