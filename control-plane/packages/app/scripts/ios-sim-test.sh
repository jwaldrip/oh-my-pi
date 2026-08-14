#!/usr/bin/env bash
# Simulator-safe UI smoke tests for ompd iOS (no live daemon).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() { bash "$ROOT/scripts/stop-metro.sh" || true; }
trap cleanup EXIT
bash "$ROOT/scripts/start-metro.sh"
cd "$ROOT/ios"

DEVICE_JSON="$(xcrun simctl list devices available -j)"
DEVICE_ID="$(DEVICE_JSON="$DEVICE_JSON" python3 - <<'PY'
import json, os, sys
data = json.loads(os.environ["DEVICE_JSON"])
wanted = None
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for d in devices:
        if d.get("isAvailable") and "iPhone" in d.get("name", ""):
            if d.get("state") == "Booted":
                print(d["udid"])
                sys.exit(0)
            wanted = wanted or d["udid"]
if wanted:
    print(wanted)
    sys.exit(0)
sys.stderr.write("no available iPhone simulator\n")
sys.exit(1)
PY
)"

echo "simulator $DEVICE_ID"
if ! xcrun simctl list devices | grep -F "$DEVICE_ID" | grep -q Booted; then
  xcrun simctl boot "$DEVICE_ID" || true
  xcrun simctl bootstatus "$DEVICE_ID" -b
fi

if [[ ! -d Pods ]]; then
  if command -v bundle >/dev/null 2>&1 && [[ -f ../Gemfile ]]; then
    (cd .. && bundle install --quiet && bundle exec pod install)
  else
    pod install
  fi
fi

xcodebuild \
  -workspace ompd.xcworkspace \
  -scheme ompd \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$DEVICE_ID" \
  -only-testing:ompdUITests/LaunchSmokeUITests \
  test
