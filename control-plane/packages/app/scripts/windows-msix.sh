#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CONFIG="${OMPD_WINDOWS_CONFIG:-Release}"
PLATFORM="${OMPD_WINDOWS_PLATFORM:-x64}"

if command -v msbuild.exe >/dev/null 2>&1; then
  MSBUILD=(msbuild.exe)
elif [[ -n "${MSBUILD_PATH:-}" ]]; then
  MSBUILD=("$MSBUILD_PATH")
else
  echo "MSBuild not found; set MSBUILD_PATH" >&2
  exit 1
fi

"${MSBUILD[@]}" windows/ompd.sln \
  -p:Configuration="$CONFIG" \
  -p:Platform="$PLATFORM" \
  -p:AppxBundle=Always \
  -p:AppxBundlePlatforms="$PLATFORM" \
  -p:AppxPackageSigningEnabled=false \
  -t:ompd_Package

echo "Look for Appx/MSIX under windows/ompd.Package/AppPackages"
find windows -name '*.msix' -o -name '*.appx' -o -name '*.msixbundle' 2>/dev/null | head
