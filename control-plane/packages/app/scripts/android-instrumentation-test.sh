#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONO="$(cd "$ROOT/../../.." && pwd)"
export NODE_PATH="$MONO/node_modules${NODE_PATH:+:$NODE_PATH}"
cleanup() {
  bash "$ROOT/scripts/stop-metro.sh" || true
  adb reverse --remove-all >/dev/null 2>&1 || true
}
trap cleanup EXIT

bash "$ROOT/scripts/start-metro.sh"

# Emulator reaches host Metro via adb reverse (10.0.2.2 also works for cleartext,
# but reverse is the reliable path on GHA emulator-runner).
adb wait-for-device
adb reverse tcp:8081 tcp:8081
adb reverse --list || true

cd "$ROOT/android"
chmod +x ./gradlew
./gradlew :app:connectedDebugAndroidTest --console=plain
