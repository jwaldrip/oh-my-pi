#!/usr/bin/env bash
# One-time identity + project bootstrap so CI can deploy ompctl to its own
# GCP project. Run once, by hand, by a human holding the waldrip.net billing
# account. Everything after this is Terraform, applied by GitHub Actions,
# never from a workstation.
#
# Creates NO application infrastructure (no Cloud Run service, no Redis, no
# Cloud Run domain mappings -- those are control-plane/packages/hub/deploy's
# main.tf, applied by CI). This script creates only what Terraform cannot
# create for itself: the project, the identity CI uses, and the substrate a
# first `terraform apply` needs already present (Artifact Registry, a VPC
# connector for private Redis access, state bucket access).
#
# Federated OIDC only: no service account key is created here, and none
# should be. GitHub proves its identity to Google per run, scoped to this one
# repository.
#
#   BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX ./control-plane/packages/hub/deploy/bootstrap.sh
set -euo pipefail

: "${BILLING_ACCOUNT_ID:?Set BILLING_ACCOUNT_ID to the waldrip.net billing account (gcloud billing accounts list)}"

PROJECT="${OMPCTL_GCP_PROJECT:-ompctl}"
REGION="${OMPCTL_GCP_REGION:-us-central1}"
REPO="${OMPCTL_GITHUB_REPO:-jwaldrip/oh-my-pi}"
POOL="ompctl-github"
PROVIDER="github"
SA="ompctl-deployer"
STATE_BUCKET="${OMPCTL_TF_STATE_BUCKET:-waldrip-net-terraform-state}"
STATE_PREFIX="hub"
NETWORK="${OMPCTL_GCP_NETWORK:-default}"
CONNECTOR="ompctl-connector"
CONNECTOR_RANGE="${OMPCTL_VPC_CONNECTOR_RANGE:-10.16.0.0/28}"
ARTIFACT_REPO="ompd"

SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

echo "==> project $PROJECT"
# `describe` failing means either the project doesn't exist yet or this
# identity lacks access to a project someone else owns under this id.
# Attempting create proves which: a real ALREADY_EXISTS is unambiguous,
# where a bare "not found" from describe alone is not.
if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  echo "    already exists"
else
  gcloud projects create "$PROJECT" --name="ompctl"
fi

echo "==> linking billing account $BILLING_ACCOUNT_ID"
gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT_ID"

echo "==> enabling required services"
gcloud services enable \
  run.googleapis.com \
  redis.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com \
  servicenetworking.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project "$PROJECT"

echo "==> deployer service account"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA" --project "$PROJECT" \
    --display-name "ompctl CI deployer" \
    --description "Builds images and applies Terraform for control-plane/packages/hub and web."

# IAM is eventually consistent: a service account created seconds ago can
# still 404 the resource-manager binding call below. Wait until it is
# actually visible rather than racing it.
for i in $(seq 1 30); do
  gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 && break
  sleep 2
done

# Scoped to what hub/main.tf actually touches. Not owner, not editor: a
# compromised CI run should be able to redeploy this stack, not take the
# project. iam.serviceAccountAdmin/resourcemanager.projectIamAdmin are
# required because the stack itself creates and binds two runtime service
# accounts (ompd-hub, ompctl-web).
for ROLE in \
  roles/run.admin \
  roles/artifactregistry.admin \
  roles/cloudbuild.builds.editor \
  roles/serviceusage.serviceUsageConsumer \
  roles/redis.admin \
  roles/secretmanager.admin \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/resourcemanager.projectIamAdmin \
  roles/compute.networkAdmin \
  roles/vpcaccess.admin
do
  for i in $(seq 1 5); do
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member "serviceAccount:${SA_EMAIL}" --role "$ROLE" --quiet >/dev/null 2>&1 && break
    sleep 3
  done
done

# 'gcloud builds submit' auto-creates and owns a project-owned staging
# bucket named exactly "${PROJECT}_cloudbuild" on first use, which is fine
# for an interactive human caller but fails for a service account: the SA
# has cloudbuild.builds.editor, not storage.buckets.create, so its first
# real submit dies with "forbidden from accessing the bucket". Pre-creating
# it here and granting only object access (never bucket-admin) avoids
# handing the deployer SA a standing bucket-creation right it does not
# otherwise need.
CLOUDBUILD_BUCKET="${PROJECT}_cloudbuild"
echo "==> cloud build staging bucket"
gcloud storage buckets describe "gs://${CLOUDBUILD_BUCKET}" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${CLOUDBUILD_BUCKET}" \
    --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://${CLOUDBUILD_BUCKET}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin --quiet >/dev/null
echo "==> artifact registry"
gcloud artifacts repositories describe "$ARTIFACT_REPO" \
  --project "$PROJECT" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$ARTIFACT_REPO" \
    --project "$PROJECT" --location "$REGION" --repository-format docker \
    --description "hub + web images for ompctl."

echo "==> serverless VPC connector (Cloud Run -> private Redis)"
gcloud compute networks vpc-access connectors describe "$CONNECTOR" \
  --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute networks vpc-access connectors create "$CONNECTOR" \
    --project "$PROJECT" --region "$REGION" \
    --network "$NETWORK" --range "$CONNECTOR_RANGE"

echo "==> terraform state access (bucket only, not project-wide, cross-project)"
gcloud storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin --quiet >/dev/null

echo "==> workload identity pool"
gcloud iam workload-identity-pools describe "$POOL" \
  --project "$PROJECT" --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" \
    --project "$PROJECT" --location global --display-name "ompctl GitHub Actions"

# The attribute condition is the security boundary. Without it, any
# repository on GitHub could mint a token for this pool and deploy into the
# project.
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project "$PROJECT" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project "$PROJECT" --location global --workload-identity-pool "$POOL" \
    --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository == '${REPO}'"

echo "==> letting $REPO impersonate the deployer"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  --quiet >/dev/null

# Cloud Run domain mapping requires the caller (this SA, via CI) to have
# verified ownership of the domain. Verify once, by hand, as the human owner:
#   gcloud domains verify ompctl.ai
# (or via https://search.google.com/search-console -- either satisfies
# Google's domain ownership check used by google_cloud_run_domain_mapping).
echo
echo "==> NOTE: verify domain ownership before the first 'terraform apply' creates"
echo "    google_cloud_run_domain_mapping resources, or they will fail:"
echo "      gcloud domains verify ompctl.ai"

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

echo
echo "==> setting GitHub Actions variables on $REPO"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO" --body "$WIF_PROVIDER"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT     --repo "$REPO" --body "$SA_EMAIL"
gh variable set GCP_PROJECT_ID                 --repo "$REPO" --body "$PROJECT"
gh variable set GCP_REGION                     --repo "$REPO" --body "$REGION"
gh variable set GCP_NETWORK_ID                 --repo "$REPO" --body "projects/${PROJECT}/global/networks/${NETWORK}"
gh variable set GCP_VPC_CONNECTOR_ID           --repo "$REPO" --body "projects/${PROJECT}/locations/${REGION}/connectors/${CONNECTOR}"
gh variable set TF_STATE_BUCKET                --repo "$REPO" --body "$STATE_BUCKET"

cat <<EOF

Bootstrapped.

Project:            $PROJECT ($PROJECT_NUMBER)
Deployer:            $SA_EMAIL
WIF provider:         $WIF_PROVIDER
State:               gs://${STATE_BUCKET}/${STATE_PREFIX}

Still required before the first "hub-deploy" run:
  1. gcloud domains verify ompctl.ai
  2. gh variable set OMPCTL_APPLE_TEAM_ID    --repo "$REPO" --body "<10-char Apple Team ID>"
  3. gh variable set OMPCTL_PLAY_CERT_SHA256 --repo "$REPO" --body "<Play app signing SHA-256>"
  4. After the first apply, create the printed Squarespace DNS records for
     app.ompctl.ai and hub.ompctl.ai (terraform output squarespace_dns_records).
EOF
