#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/macos"
TEAM_ID="${OMPD_APPLE_TEAM_ID:?OMPD_APPLE_TEAM_ID is required}"
OUT="${OMPD_MACOS_ARCHIVE_DIR:-$ROOT/build/macos}"
mkdir -p "$OUT"
METHOD="${OMPD_MACOS_EXPORT_METHOD:-app-store-connect}"

if [[ ! -d ompd.xcworkspace && ! -d ompd.xcodeproj ]]; then
  echo "macos xcode project missing" >&2
  exit 1
fi

PROJECT_ARGS=()
if [[ -d ompd.xcworkspace ]]; then
  PROJECT_ARGS=(-workspace ompd.xcworkspace -scheme ompd-macOS)
else
  PROJECT_ARGS=(-project ompd.xcodeproj -scheme ompd-macOS)
fi

AUTH_ARGS=()
if [[ -n "${OMPD_ASC_KEY_PATH:-}" && -n "${OMPD_ASC_KEY_ID:-}" && -n "${OMPD_ASC_ISSUER_ID:-}" ]]; then
  AUTH_ARGS+=(
    -allowProvisioningUpdates
    -authenticationKeyPath "$OMPD_ASC_KEY_PATH"
    -authenticationKeyID "$OMPD_ASC_KEY_ID"
    -authenticationKeyIssuerID "$OMPD_ASC_ISSUER_ID"
  )
fi

xcodebuild \
  "${PROJECT_ARGS[@]}" \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$OUT/ompd-mac.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER=sh.ompd.macos \
  CODE_SIGN_STYLE=Automatic \
  "${AUTH_ARGS[@]}" \
  archive

EXPORT_PLIST="$OUT/ExportOptions.plist"
cat >"$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${METHOD}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$OUT/ompd-mac.xcarchive" \
  -exportPath "$OUT/export" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${AUTH_ARGS[@]}"
echo "MAC_EXPORT=$OUT/export"
ls -la "$OUT/export"
# Verify exported .app signature when present
APP_PATH="$(find "$OUT/export" -type d -name '*.app' -print -quit | head -1 || true)"
if [[ -z "$APP_PATH" ]]; then
  echo "No .app found under $OUT/export" >&2
  ls -laR "$OUT/export" || true
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dvv "$APP_PATH" 2>&1 | awk -F= '/TeamIdentifier/{print "mac_team",$2}'
