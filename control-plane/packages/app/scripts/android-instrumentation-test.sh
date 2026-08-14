#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() { bash "$ROOT/scripts/stop-metro.sh" || true; }
trap cleanup EXIT
bash "$ROOT/scripts/start-metro.sh"
cd "$ROOT/android"
chmod +x ./gradlew
# Emulator must reach host Metro. On GHA emulator-runner, 10.0.2.2 maps to host loopback.
./gradlew :app:connectedDebugAndroidTest --console=plain
