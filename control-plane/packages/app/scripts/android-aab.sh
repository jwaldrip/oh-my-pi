#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MONO="$(cd "$ROOT/../../.." && pwd)"
export NODE_PATH="$MONO/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$ROOT/android"
chmod +x ./gradlew

: "${OMPD_ANDROID_KEYSTORE_PATH:?OMPD_ANDROID_KEYSTORE_PATH is required}"
: "${OMPD_ANDROID_KEYSTORE_PASSWORD:?OMPD_ANDROID_KEYSTORE_PASSWORD is required}"
: "${OMPD_ANDROID_KEY_ALIAS:?OMPD_ANDROID_KEY_ALIAS is required}"
: "${OMPD_ANDROID_KEY_PASSWORD:?OMPD_ANDROID_KEY_PASSWORD is required}"

./gradlew :app:bundleRelease --console=plain
AAB="$ROOT/android/app/build/outputs/bundle/release/app-release.aab"
test -f "$AAB"
echo "AAB_PATH=$AAB"
python3 - <<'PY' "$AAB"
import sys
from pathlib import Path
aab = Path(sys.argv[1])
print("aab_bytes", aab.stat().st_size)
print("aab_ok", aab.exists())
PY
