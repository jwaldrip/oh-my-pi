#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Monorepo root (bun hoist)
MONO="$(cd "$ROOT/../../.." && pwd)"
export NODE_PATH="$MONO/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$ROOT/android"
chmod +x ./gradlew
./gradlew :app:testDebugUnitTest --console=plain
