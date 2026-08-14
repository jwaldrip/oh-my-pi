#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONO="$(cd "$ROOT/../../.." && pwd)"
export NODE_PATH="$MONO/node_modules${NODE_PATH:+:$NODE_PATH}"
cleanup() { bash "$ROOT/scripts/stop-metro.sh" || true; }
trap cleanup EXIT
bash "$ROOT/scripts/start-metro.sh"
cd "$ROOT/android"
chmod +x ./gradlew
./gradlew :app:connectedDebugAndroidTest --console=plain
