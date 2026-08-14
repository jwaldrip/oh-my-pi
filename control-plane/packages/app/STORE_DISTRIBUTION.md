# ompd store test-track distribution

Product identity (all platforms):

| Platform | ID |
|----------|----|
| iOS | `sh.ompd.app` |
| Android | `sh.ompd.app` |
| macOS | `sh.ompd.macos` |
| Windows | `sh.ompd.app` (Publisher `CN=ompd`) |

## Test tracks

- **iOS**: App Store Connect → TestFlight (internal then external)
- **Android**: Play Console → Internal testing
- **macOS**: App Store Connect Mac TestFlight (or Developer ID notarized build via `OMPD_MACOS_EXPORT_METHOD=developer-id`)
- **Windows**: MSIX package for Microsoft Store / sideload; Store upload is manual until Partner Center credentials exist

## GitHub Actions

- `.github/workflows/app-mobile-test.yml` — always-on JS + Android unit + Android emulator + iOS simulator smoke
- `.github/workflows/app-store-distribute.yml` — `workflow_dispatch` / `ompd-app-v*` tags; builds artifacts and uploads when secrets are present

## Required repository secrets

### Apple (iOS + macOS)

| Secret | Purpose |
|--------|---------|
| `OMPD_APPLE_TEAM_ID` | 10-char Apple Developer Team ID |
| `OMPD_ASC_KEY_ID` | App Store Connect API key id |
| `OMPD_ASC_ISSUER_ID` | App Store Connect issuer UUID |
| `OMPD_ASC_PRIVATE_KEY` | Contents of `AuthKey_<id>.p8` |
| `OMPD_APPLE_CERT_P12_BASE64` | Base64 of Apple Distribution (iOS) or Developer ID/Distribution (macOS) `.p12` |
| `OMPD_APPLE_CERT_P12_PASSWORD` | Password for that `.p12` |

GitHub-hosted macOS runners have no signing identities. The workflow imports the `.p12` into an ephemeral keychain and uses the ASC API key with `-allowProvisioningUpdates` so Xcode can create/download provisioning profiles at archive time.

Create the ASC key under App Store Connect → Users and Access → Integrations → App Store Connect API, role **App Manager** (or Admin). Register bundle IDs `sh.ompd.app` and `sh.ompd.macos` before the first upload.

### Google Play (Android Internal testing)

| Secret | Purpose |
|--------|---------|
| `OMPD_ANDROID_KEYSTORE_BASE64` | Base64 of the upload keystore (`.jks`/`.keystore`) |
| `OMPD_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `OMPD_ANDROID_KEY_ALIAS` | Key alias |
| `OMPD_ANDROID_KEY_PASSWORD` | Key password |
| `OMPD_PLAY_SERVICE_ACCOUNT_JSON` | Full JSON for a Play Console API service account |

Release builds **never** use `debug.keystore`. `./gradlew :app:bundleRelease` fails closed without the upload key.

Play Console must already have app `sh.ompd.app` created (first AAB can be a manual draft upload if the API rejects the very first binary).

### Windows (optional later)

Partner Center / Store association is not automated yet. The workflow produces an unsigned or locally signed MSIX artifact for sideload/Store packaging.

## Local commands

```bash
cd control-plane/packages/app
bun test                       # JS/TS
bun run test:android:unit      # JVM
bun run test:android:instrumentation  # emulator
bun run test:ios:sim           # LaunchSmokeUITests only
bun run build:android:aab      # needs OMPD_ANDROID_* env
bun run build:ios:archive      # needs OMPD_APPLE_TEAM_ID + signing
bun run upload:play-internal
bun run upload:testflight
```

Device-only pairing proof remains `ompdUITests/PairingUITests` and still requires
`OMPD_TEST_ENDPOINT`, `OMPD_TEST_TOKEN`, `OMPD_TEST_AGENT_ID`, `OMPD_TEST_NONCE` on a tethered phone.
