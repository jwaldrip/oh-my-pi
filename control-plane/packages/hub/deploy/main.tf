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
