#!/usr/bin/env bash
# Import an Apple Distribution (or Developer ID) .p12 into a temporary keychain
# for CI archive/export. Never prints secret material.
set -euo pipefail

: "${OMPD_APPLE_CERT_P12_BASE64:?OMPD_APPLE_CERT_P12_BASE64 is required}"
: "${OMPD_APPLE_CERT_P12_PASSWORD:?OMPD_APPLE_CERT_P12_PASSWORD is required}"

KEYCHAIN_PATH="${OMPD_APPLE_KEYCHAIN_PATH:-${RUNNER_TEMP:-/tmp}/ompd-signing.keychain-db}"
KEYCHAIN_PASSWORD="${OMPD_APPLE_KEYCHAIN_PASSWORD:-$(openssl rand -base64 32)}"
P12_PATH="${RUNNER_TEMP:-/tmp}/ompd-dist.p12"

python3 - <<'PY' > "$P12_PATH"
import base64, os, sys
raw = os.environ["OMPD_APPLE_CERT_P12_BASE64"].strip()
# tolerate whitespace/newlines in secret values
raw = "".join(raw.split())
sys.stdout.buffer.write(base64.b64decode(raw))
PY
chmod 600 "$P12_PATH"
wc -c "$P12_PATH" | awk '{print "p12_bytes",$1}'

# Create / unlock ephemeral keychain
security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

# Put it first on the search list while keeping login keychain available
EXISTING="$(security list-keychains -d user | sed -E 's/^[[:space:]]*"|"$//g' | tr '\n' ' ')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN_PATH" $EXISTING

security import "$P12_PATH" \
  -P "$OMPD_APPLE_CERT_P12_PASSWORD" \
  -A \
  -t cert \
  -f pkcs12 \
  -k "$KEYCHAIN_PATH"

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH" >/dev/null

# Prove a signing identity exists without dumping secret material.
# `security find-identity -v` lines look like:
#   1) ABCD1234... "Apple Distribution: Example (TEAMID)"
# and end with:
#      1 valid identities found
IDENT_OUT="$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" || true)"
COUNT="$(printf '%s\n' "$IDENT_OUT" | grep -E '^[[:space:]]*[0-9]+\)' | wc -l | tr -d ' ')"
VALID_LINE="$(printf '%s\n' "$IDENT_OUT" | grep -E 'valid identities found' | tail -1 || true)"
echo "codesigning_identities $COUNT"
echo "codesigning_summary ${VALID_LINE:-none}"
if [[ "${COUNT:-0}" -lt 1 ]]; then
  echo "No codesigning identities in ephemeral keychain" >&2
  printf '%s\n' "$IDENT_OUT" | sed -E 's/"[^"]+"/"<redacted>"/g' || true
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "OMPD_APPLE_KEYCHAIN_PATH=$KEYCHAIN_PATH"
    echo "OMPD_APPLE_KEYCHAIN_PASSWORD=$KEYCHAIN_PASSWORD"
  } >> "$GITHUB_ENV"
fi

rm -f "$P12_PATH"
echo "apple_signing_keychain_ready"
