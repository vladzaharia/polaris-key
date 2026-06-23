# backend.tf
#
# State backend configuration.
#
# DEFAULT: local backend (terraform.tfstate on disk). This lets
# `terraform init -backend=false` and `terraform validate` run without any
# cloud credentials, and is fine for first-time bootstrapping. State is written
# locally and should NOT be committed (see .gitignore).
#
# PRODUCTION: switch to a remote backend so state is shared and locked. Two
# documented options below.
#
# ---------------------------------------------------------------------------
# Option A — Cloudflare R2 via the S3-compatible backend (recommended here).
#
#   1. Create an R2 bucket (e.g. `polaris-key-tfstate`) and an R2 API token
#      (S3 access key id + secret).
#   2. Export the credentials for the backend:
#        export AWS_ACCESS_KEY_ID=<r2_access_key_id>
#        export AWS_SECRET_ACCESS_KEY=<r2_secret_access_key>
#   3. Replace the local backend by UNCOMMENTING the block below (and remove or
#      comment out the `backend "local"` block), filling in <ACCOUNT_ID>.
#   4. Re-run `terraform init -migrate-state`.
#
#   Use one `key` per environment (e.g. via -backend-config) so dev/staging/prod
#   don't share a state file.
#
# terraform {
#   backend "s3" {
#     bucket = "polaris-key-tfstate"
#     key    = "key.plrs.im/<environment>/terraform.tfstate"
#     region = "auto"
#
#     # R2 S3-compatible endpoint for your account.
#     endpoints = {
#       s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
#     }
#
#     # R2 is not real AWS S3, so disable the AWS-specific validation/features.
#     skip_credentials_validation = true
#     skip_region_validation      = true
#     skip_requesting_account_id  = true
#     skip_metadata_api_check     = true
#     skip_s3_checksum            = true
#     use_path_style              = true
#   }
# }
#
# ---------------------------------------------------------------------------
# Option B — Terraform Cloud / HCP Terraform (managed remote state + runs).
#
# terraform {
#   cloud {
#     organization = "polaris"
#     workspaces {
#       # One workspace per environment, e.g. polaris-key-dev / -staging / -prod.
#       name = "polaris-key-<environment>"
#     }
#   }
# }
# ---------------------------------------------------------------------------

terraform {
  backend "local" {}
}
