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
  PRODUCT_BUNDLE_IDENTIFIER=ai.ompctl.macos \
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

# App Store export is typically a .pkg; Developer ID may yield .app / .dmg.
PKG_PATH="$(find "$OUT/export" -type f \( -name '*.pkg' -o -name '*.dmg' \) -print | head -1 || true)"
APP_PATH="$(find "$OUT/export" -type d -name '*.app' -print -quit | head -1 || true)"

if [[ -n "$APP_PATH" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  codesign -dvv "$APP_PATH" 2>&1 | awk -F= '/TeamIdentifier/{print "mac_team",$2}'
elif [[ -n "$PKG_PATH" ]]; then
  echo "mac_export_package $PKG_PATH"
  # pkgutil validates structure without requiring an unpacked .app
  if [[ "$PKG_PATH" == *.pkg ]]; then
    pkgutil --check-signature "$PKG_PATH" || true
  fi
  # Also try to verify the app nested inside the archive used for export
  ARCH_APP="$(find "$OUT/ompd-mac.xcarchive/Products" -type d -name '*.app' -print -quit | head -1 || true)"
  if [[ -n "$ARCH_APP" ]]; then
    codesign --verify --deep --strict --verbose=2 "$ARCH_APP"
    codesign -dvv "$ARCH_APP" 2>&1 | awk -F= '/TeamIdentifier/{print "mac_archive_team",$2}'
  fi
else
  echo "No .pkg/.dmg/.app found under $OUT/export" >&2
  ls -laR "$OUT/export" || true
  exit 1
fi
