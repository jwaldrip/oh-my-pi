#!/usr/bin/env bash
set -euo pipefail
IPA="${1:-}"
if [[ -z "$IPA" ]]; then
  IPA="$(ls -1 "$(cd "$(dirname "$0")/.." && pwd)/build/ios/ipa"/*.ipa 2>/dev/null | head -1 || true)"
fi
: "${IPA:?pass path to .ipa or build one first}"
: "${OMPD_ASC_KEY_ID:?OMPD_ASC_KEY_ID required}"
: "${OMPD_ASC_ISSUER_ID:?OMPD_ASC_ISSUER_ID required}"
: "${OMPD_ASC_KEY_PATH:?OMPD_ASC_KEY_PATH required (AuthKey_XXX.p8)}"

export API_PRIVATE_KEYS_DIR
API_PRIVATE_KEYS_DIR="$(cd "$(dirname "$OMPD_ASC_KEY_PATH")" && pwd)"

xcrun altool --upload-app \
  --type ios \
  --file "$IPA" \
  --apiKey "$OMPD_ASC_KEY_ID" \
  --apiIssuer "$OMPD_ASC_ISSUER_ID"

echo "uploaded $IPA to App Store Connect (TestFlight processing is async on Apple side)"
