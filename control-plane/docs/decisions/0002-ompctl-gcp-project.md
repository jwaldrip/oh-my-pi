# 0002. Host ompctl in its own GCP project, not waldrip-net

Date: 2026-08-15
Status: accepted

## Context

`waldrip-net` is Jason's personal catch-all GCP project: it hosts `cld` telemetry,
`haiku-method`/`ai-dlc` auth proxies, `field-agent`, and `im-a-cto`. ompctl (the
oh-my-pi hub + web console at ompctl.ai) is a distinct product with its own
domain, its own Cloud Run services, and eventually its own billing story if it
ever needs one separate from Jason's personal spend.

## Decision

A dedicated project, `ompctl`, billed under the same **waldrip.net billing
account** that already covers `waldrip-net`, `darkrun.ai`, `haikumethod.ai`.
Not `waldrip-net` itself.

## Consequences

- IAM blast radius for a compromised `ompctl` deploy is scoped to `ompctl`
  only; it cannot touch `waldrip-net`'s BigQuery telemetry or other stacks.
- Terraform state still lives in the existing shared bucket
  (`waldrip-net-terraform-state`, prefix `hub`) rather than a new bucket,
  because state buckets are cheap to share and expensive to bootstrap twice.
  This means the `ompctl-deployer` service account (in the `ompctl` project)
  needs a **cross-project** `roles/storage.objectAdmin` grant on that bucket,
  done once by hand in `bootstrap.sh` — same shape as every other personal
  stack's prerequisite, just crossing a project boundary this time.
- A new Workload Identity Federation pool (`ompctl-github`) is created in the
  `ompctl` project rather than reusing `waldrip-net`'s, so `jwaldrip/oh-my-pi`
  CI never holds an identity that could reach `waldrip-net`.
- Billing rollup, quota, and org-policy stay shared with the rest of Jason's
  personal projects, which is the point of using one billing account.

See `control-plane/packages/hub/deploy/bootstrap.sh` for the one-time setup
this decision requires.
