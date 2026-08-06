#!/bin/bash
# Повторно ставить у Codex-чергу всі задачі QA Desk, чий останній ран failed.
# Ідемпотентний: активні/успішні рани не чіпає. Використовується після резету
# ліміту Codex (або вручну: bash requeue-failed.sh).
set -u
TOKEN=$(grep '^CODEX_TRIGGER_TOKEN=' /root/projects/gba-bug-host/.env | cut -d= -f2)
BASE="http://127.0.0.1:4000/api/tasks"

curl -sS "$BASE" | python3 -c "
import json, sys
tasks = json.load(sys.stdin)
for task in tasks:
    run = task.get('agentRun') or {}
    if run.get('status') == 'failed':
        print(task['id'])
" | while read -r id; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/$id/agent-runs" -H "X-Codex-Trigger-Token: $TOKEN")
  echo "$(date -Is) requeue $id: $code"
done
