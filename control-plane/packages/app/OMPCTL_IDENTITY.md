# ompctl identity

Product domain: **ompctl.ai** (Squarespace).

| Surface | Value |
|---------|--------|
| iOS bundle id | `ai.ompctl.app` |
| Android applicationId | `ai.ompctl.app` |
| macOS bundle id | `ai.ompctl.macos` |
| Windows package | `ai.ompctl.app` |
| Web / Universal Links | `https://app.ompctl.ai` (Cloud Run **ompctl-web**) |
| Hub / relay | `https://hub.ompctl.ai` (Cloud Run **ompd-hub**) |
| Custom URL scheme | `ompctl://` |
| Collab join URL | `https://app.ompctl.ai/collab/<roomId>` |

## Host split (load-bearing)

- **`app.ompctl.ai`** serves the web console **and** `/.well-known/apple-app-site-association` + `assetlinks.json`.
- **`hub.ompctl.ai`** is the websocket relay only. It does **not** serve the SPA or association files.

Mapping the app host onto the hub image would break Universal Links and leave the web app undeployed.

## Squarespace DNS

Terraform does not write Squarespace. After CI `terraform apply`:

```bash
terraform -chdir=control-plane/packages/hub/deploy output -json squarespace_dns_records
```

Create the printed CNAME/A records under ompctl.ai. Apex stays on Squarespace for the marketing site.

## GitHub Actions vars (hub-deploy environment)

| Var | Purpose |
|-----|---------|
| `GCP_*` / `TF_STATE_BUCKET` | existing deploy |
| `OMPCTL_APPLE_TEAM_ID` | AASA `appIDs` |
| `OMPCTL_PLAY_CERT_SHA256` | assetlinks fingerprint |
| `OMPCTL_APP_DOMAIN` | default `app.ompctl.ai` |
| `OMPCTL_HUB_DOMAIN` | default `hub.ompctl.ai` |

## Store consoles

Register apps under the new bundle ids (not `sh.ompd.*`):

- App Store Connect: `ai.ompctl.app`, `ai.ompctl.macos`
- Play Console: `ai.ompctl.app`
