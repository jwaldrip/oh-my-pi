#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AAB="${1:-$ROOT/android/app/build/outputs/bundle/release/app-release.aab}"
test -f "$AAB"
: "${OMPD_PLAY_SERVICE_ACCOUNT_JSON:?OMPD_PLAY_SERVICE_ACCOUNT_JSON path required}"
PACKAGE_NAME="${OMPD_PLAY_PACKAGE_NAME:-sh.ompd.app}"

python3 - <<'PY' "$AAB" "$OMPD_PLAY_SERVICE_ACCOUNT_JSON" "$PACKAGE_NAME"
import json, sys
from pathlib import Path
aab, sa_path, package = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
except ImportError as e:
    raise SystemExit(
        "google-api-python-client and google-auth are required for Play upload. "
        "pip install google-api-python-client google-auth"
    ) from e

creds = service_account.Credentials.from_service_account_file(
    sa_path,
    scopes=["https://www.googleapis.com/auth/androidpublisher"],
)
service = build("androidpublisher", "v3", credentials=creds, cache_discovery=False)
edit = service.edits().insert(body={}, packageName=package).execute()
edit_id = edit["id"]
media = MediaFileUpload(aab, mimetype="application/octet-stream", resumable=True)
bundle = service.edits().bundles().upload(
    editId=edit_id, packageName=package, media_body=media
).execute()
version_code = bundle["versionCode"]
service.edits().tracks().update(
    editId=edit_id,
    packageName=package,
    track="internal",
    body={
        "track": "internal",
        "releases": [{"status": "completed", "versionCodes": [str(version_code)]}],
    },
).execute()
service.edits().commit(editId=edit_id, packageName=package).execute()
print(json.dumps({"package": package, "track": "internal", "versionCode": version_code}))
PY
