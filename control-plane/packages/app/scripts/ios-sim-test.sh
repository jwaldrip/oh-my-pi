#!/usr/bin/env bash
# Simulator-safe UI smoke tests for ompd iOS (no live daemon).
# Must run under an Xcode that has an iOS Simulator runtime installed
# (workflow selects Xcode 16+ before invoking this script).
#
# Usage: ios-sim-test.sh [iPhone|iPad]  (default: iPhone)
set -euo pipefail
FAMILY="${1:-iPhone}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() { bash "$ROOT/scripts/stop-metro.sh" || true; }
trap cleanup EXIT
bash "$ROOT/scripts/start-metro.sh"
cd "$ROOT/ios"

echo "xcode $(xcodebuild -version | tr '\n' ' ')"

# Prefer a generic destination name that exists on the selected Xcode.
# Creating by UDID from a different Xcode install is what broke CI earlier.
pick_destination() {
  DEVICE_FAMILY="$FAMILY" python3 - <<'PY'
import json, os, subprocess, sys

def run(args):
    return subprocess.check_output(args, text=True)

family = os.environ.get("DEVICE_FAMILY", "iPhone")

runtimes = json.loads(run(["xcrun", "simctl", "list", "runtimes", "-j"])).get("runtimes", [])
ios_runtimes = [
    r for r in runtimes
    if r.get("isAvailable") and str(r.get("name", "")).startswith("iOS")
]
if not ios_runtimes:
    sys.stderr.write("no available iOS simulator runtimes under current Xcode\n")
    sys.exit(1)
# newest runtime first
ios_runtimes.sort(key=lambda r: r.get("version", ""), reverse=True)
runtime = ios_runtimes[0]
print(f"runtime {runtime.get('name')} {runtime.get('identifier')}", file=sys.stderr)

devices = json.loads(run(["xcrun", "simctl", "list", "devices", "available", "-j"])).get("devices", {})
# Prefer an already-booted device of the requested family on this runtime
for d in devices.get(runtime["identifier"], []):
    if d.get("isAvailable") and family in d.get("name", "") and d.get("state") == "Booted":
        print(d["udid"])
        print(f"using_booted {d['name']}", file=sys.stderr)
        sys.exit(0)

# Prefer an existing device of the requested family on this runtime
preferred_names = {
    "iPhone": ["iPhone 16", "iPhone 16 Pro", "iPhone 15", "iPhone 15 Pro", "iPhone SE (3rd generation)"],
    "iPad": ["iPad (A16)", "iPad Air 11-inch (M4)", "iPad Pro 11-inch (M5)", "iPad mini (A17 Pro)"],
}.get(family, [])
candidates = [d for d in devices.get(runtime["identifier"], []) if d.get("isAvailable") and family in d.get("name", "")]
for name in preferred_names:
    for d in candidates:
        if d.get("name") == name:
            print(d["udid"])
            print(f"using_existing {d['name']}", file=sys.stderr)
            sys.exit(0)
if candidates:
    d = candidates[0]
    print(d["udid"])
    print(f"using_existing {d['name']}", file=sys.stderr)
    sys.exit(0)

# Create one
devtypes = json.loads(run(["xcrun", "simctl", "list", "devicetypes", "-j"])).get("devicetypes", [])
family_types = [t for t in devtypes if t.get("productFamily") == family]
type_id = None
type_name = None
for want in preferred_names:
    for t in family_types:
        if want in t.get("name", ""):
            type_id = t["identifier"]
            type_name = t["name"]
            break
    if type_id:
        break
if not type_id and family_types:
    type_id = family_types[0]["identifier"]
    type_name = family_types[0]["name"]
if not type_id:
    sys.stderr.write(f"no {family} device types\n")
    sys.exit(1)
name = f"ompd-ci-{type_name.replace(' ', '-')}"
udid = run(["xcrun", "simctl", "create", name, type_id, runtime["identifier"]]).strip()
print(udid)
print(f"created {name} {udid}", file=sys.stderr)
PY
}

DEVICE_ID="$(pick_destination)"
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

# Use id under the currently selected Xcode; also pass a name fallback via generic platform
xcodebuild \
  -workspace ompd.xcworkspace \
  -scheme ompd \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$DEVICE_ID" \
  -only-testing:ompdUITests/LaunchSmokeUITests \
  test
