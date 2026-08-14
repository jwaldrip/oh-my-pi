#!/usr/bin/env bash
# Start Metro for native smoke tests and wait until it accepts connections.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${RCT_METRO_PORT:-8081}"
LOG="${OMPD_METRO_LOG:-${RUNNER_TEMP:-/tmp}/ompd-metro.log}"
PID_FILE="${OMPD_METRO_PID_FILE:-${RUNNER_TEMP:-/tmp}/ompd-metro.pid}"

if curl -sf "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1; then
  echo "metro_already_up port=$PORT"
  exit 0
fi

# Prefer workspace react-native CLI via bunx/npx from package dir
nohup bunx react-native start --port "$PORT" --host 127.0.0.1 >"$LOG" 2>&1 &
echo $! >"$PID_FILE"
echo "metro_pid $(cat "$PID_FILE")"

for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1; then
    echo "metro_ready seconds=$i port=$PORT"
    exit 0
  fi
  # also accept the HTML landing / symbolicate endpoints coming up
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "metro_ready_root seconds=$i port=$PORT"
    exit 0
  fi
  sleep 1
done

echo "Metro failed to become ready on :$PORT" >&2
tail -n 100 "$LOG" >&2 || true
exit 1
