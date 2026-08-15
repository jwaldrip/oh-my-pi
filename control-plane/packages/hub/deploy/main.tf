# The hub, on Cloud Run. NOT APPLIED. Deploys run in CI on this project, never
# from a workstation, so this is the description of the target and nothing here
# has been executed.
#
# Two choices are load-bearing and worth reading before changing.
#
# `min_instance_count = 1`. The hub holds websockets, and an instance that
# scales to zero drops every daemon on it. The daemons reconnect, so this is a
# cost decision rather than a correctness one, but a hub that is always cold is
# a hub that is always reconnecting.
#
# Memorystore, not memory. Two legs of one session routinely land on two
# instances, and Cloud Run session affinity is best-effort, which is not a
# correctness mechanism. The routing table therefore lives outside the process.
# Without this the service only works pinned to a single instance.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "image" { type = string }

variable "network_id" {
  type        = string
  description = "VPC the connector and Memorystore share."
}

variable "connector_id" {
  type        = string
  description = "Serverless VPC connector, so Cloud Run can reach Memorystore."
}

resource "google_redis_instance" "hub" {
  project = var.project_id
  region  = var.region

  name           = "ompd-hub"
  tier           = "BASIC"
  memory_size_gb = 1
  # Presence leases and a pub/sub fan-out. Nothing here is durable by design:
  # a total loss of this instance drops every session and every daemon
  # reconnects, which is a state the protocol already treats as normal.
  redis_version      = "REDIS_7_0"
  authorized_network = var.network_id
}

resource "google_secret_manager_secret" "operator_token" {
  project   = var.project_id
  secret_id = "ompd-hub-operator-token"
  replication {
    auto {}
  }
}

resource "google_service_account" "hub" {
  project    = var.project_id
  account_id = "ompd-hub"
}

resource "google_secret_manager_secret_iam_member" "hub_reads_operator_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.operator_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.hub.email}"
}

resource "google_cloud_run_v2_service" "hub" {
  project  = var.project_id
  location = var.region
  name     = "ompd-hub"

  # The hub brokers access to machines that execute code, and it authenticates
  # its own callers: daemons by signature, clients by a credential only the
  # daemon can read. IAM in front would break both legs, which arrive as
  # websockets from a phone and a laptop with no Google identity.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.hub.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    vpc_access {
      connector = var.connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    # Cloud Run caps a request at 60 minutes and a websocket is a request, so
    # every connection is closed on a timer no matter what. Both ends treat
    # that as routine: the daemon reconnects with backoff and the client
    # resumes with `attach { sinceSeq }`.
    timeout = "3600s"

    containers {
      image = var.image

      env {
        name  = "OMPD_HUB_REDIS_URL"
        value = "redis://${google_redis_instance.hub.host}:${google_redis_instance.hub.port}"
      }

      env {
        name = "OMPD_HUB_OPERATOR_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.operator_token.secret_id
            version = "latest"
          }
        }
      }

      resources {
        # CPU stays allocated: a relay with no CPU between requests cannot
        # service a websocket, which is one long request with quiet stretches.
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/v1/health"
        }
      }
    }
  }
}

output "hub_url" {
  value = google_cloud_run_v2_service.hub.uri
}


# --- ompctl.ai edge: hub.ompctl.ai (relay) + app.ompctl.ai (web) -------------
# Squarespace owns DNS for ompctl.ai. Terraform manages GCP only and outputs
# the records Squarespace must create after apply.

variable "app_domain" {
  type        = string
  description = "Public web + Universal Links host."
  default     = "app.ompctl.ai"
}

variable "hub_domain" {
  type        = string
  description = "Public hub/relay host."
  default     = "hub.ompctl.ai"
}

variable "web_image" {
  type        = string
  description = "Container image for the ompctl web console (app.ompctl.ai)."
}

variable "apple_team_id" {
  type        = string
  description = "Apple Team ID embedded in apple-app-site-association (10-char)."

  validation {
    condition     = can(regex("^[A-Z0-9]{10}$", var.apple_team_id))
    error_message = "apple_team_id must be a 10-character Apple Team ID; association files cannot ship placeholders."
  }
}

variable "play_cert_sha256" {
  type        = string
  description = "Google Play app signing certificate SHA-256 for assetlinks.json (not the upload key)."

  validation {
    condition = can(regex("^(?i)([0-9A-F]{2}:){31}[0-9A-F]{2}$", var.play_cert_sha256)) || can(regex("^(?i)[0-9A-F]{64}$", var.play_cert_sha256))
    error_message = "play_cert_sha256 must be the Play app signing cert SHA-256 fingerprint (with or without colons)."
  }
}

resource "google_service_account" "web" {
  project    = var.project_id
  account_id = "ompctl-web"
}

resource "google_cloud_run_v2_service" "web" {
  project  = var.project_id
  location = var.region
  name     = "ompctl-web"

  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = var.web_image

      env {
        name  = "OMPCTL_APPLE_TEAM_ID"
        value = var.apple_team_id
      }

      env {
        name  = "OMPCTL_PLAY_CERT_SHA256"
        value = var.play_cert_sha256
      }

      env {
        name  = "OMPCTL_IOS_BUNDLE_ID"
        value = "ai.ompctl.app"
      }

      env {
        name  = "OMPCTL_MACOS_BUNDLE_ID"
        value = "ai.ompctl.macos"
      }

      env {
        name  = "OMPCTL_ANDROID_PACKAGE"
        value = "ai.ompctl.app"
      }

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_domain_mapping" "app" {
  project  = var.project_id
  location = var.region
  name     = var.app_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web.name
  }
}

resource "google_cloud_run_domain_mapping" "hub" {
  project  = var.project_id
  location = var.region
  name     = var.hub_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.hub.name
  }
}

output "app_domain" { value = var.app_domain }
output "hub_domain" { value = var.hub_domain }
output "web_url" { value = google_cloud_run_v2_service.web.uri }

output "squarespace_dns_records" {
  description = "Create these at Squarespace DNS for ompctl.ai after apply."
  value = {
    app = [
      for rr in try(google_cloud_run_domain_mapping.app.status[0].resource_records, []) : {
        type   = rr.type
        host   = var.app_domain
        rrdata = rr.rrdata
      }
    ]
    hub = [
      for rr in try(google_cloud_run_domain_mapping.hub.status[0].resource_records, []) : {
        type   = rr.type
        host   = var.hub_domain
        rrdata = rr.rrdata
      }
    ]
  }
}

output "product_identity" {
  value = {
    ios_bundle_id     = "ai.ompctl.app"
    android_package   = "ai.ompctl.app"
    macos_bundle_id   = "ai.ompctl.macos"
    windows_package   = "ai.ompctl.app"
    web_origin        = "https://${var.app_domain}"
    hub_origin        = "https://${var.hub_domain}"
    collab_link_base  = "https://${var.app_domain}/collab"
    custom_url_scheme = "ompctl"
  }
}
