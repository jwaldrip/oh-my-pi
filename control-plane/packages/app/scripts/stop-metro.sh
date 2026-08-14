#!/usr/bin/env bash
set -euo pipefail
PID_FILE="${OMPD_METRO_PID_FILE:-${RUNNER_TEMP:-/tmp}/ompd-metro.pid}"
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    echo "metro_stopped pid=$PID"
  fi
  rm -f "$PID_FILE"
else
  echo "metro_pid_file_absent"
fi
# Best-effort: anything still bound to 8081 from this runner
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:8081 -sTCP:LISTEN || true)"
  if [[ -n "$PIDS" ]]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
  fi
fi
