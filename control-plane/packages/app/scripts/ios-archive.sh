#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/ios"
TEAM_ID="${OMPD_APPLE_TEAM_ID:?OMPD_APPLE_TEAM_ID is required}"
OUT="${OMPD_IOS_ARCHIVE_DIR:-$ROOT/build/ios}"
mkdir -p "$OUT"

if [[ ! -d Pods ]]; then
  if command -v bundle >/dev/null 2>&1 && [[ -f ../Gemfile ]]; then
    (cd .. && bundle install --quiet && bundle exec pod install)
  else
    pod install
  fi
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
  -workspace ompd.xcworkspace \
  -scheme ompd \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/ompd.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER=sh.ompd.app \
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
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <true/>
</dict>
</plist>
PLIST

xcodebuild \
  -exportArchive \
  -archivePath "$OUT/ompd.xcarchive" \
  -exportPath "$OUT/ipa" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${AUTH_ARGS[@]}"

# Prove the IPA carries a distribution signature before upload.
IPA_FILE="$(ls -1 "$OUT/ipa"/*.ipa | head -1)"
test -f "$IPA_FILE"
TMP_EXTRACT="$OUT/ipa-verify"
rm -rf "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"
unzip -q "$IPA_FILE" -d "$TMP_EXTRACT"
APP_PATH="$(find "$TMP_EXTRACT" -type d -name '*.app' -print -quit | head -1)"
test -n "$APP_PATH"
test -d "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
CODESIGN_TEAM="$(codesign -dvv "$APP_PATH" 2>&1 | awk -F= '/TeamIdentifier/{print $2}' | tr -d '[:space:]')"
echo "ipa_team $CODESIGN_TEAM"
if [[ -n "$TEAM_ID" && "$CODESIGN_TEAM" != "$TEAM_ID" ]]; then
  echo "IPA TeamIdentifier $CODESIGN_TEAM does not match OMPD_APPLE_TEAM_ID $TEAM_ID" >&2
  exit 1
fi
echo "IPA_PATH=$IPA_FILE"

echo "IPA_DIR=$OUT/ipa"
ls -la "$OUT/ipa"
