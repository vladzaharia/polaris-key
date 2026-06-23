# variables.tf
#
# Input variables for the Polaris Key Cloudflare infrastructure. Per-environment
# values live in envs/<env>.tfvars; the API token is supplied out-of-band via
# the TF_VAR_cloudflare_api_token environment variable (never a tfvars file).

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token used to manage Workers, D1, KV and routes. Supply this
    via the TF_VAR_cloudflare_api_token environment variable, NOT a tfvars file,
    so the secret never lands on disk or in version control.

    Required token scopes: Workers Scripts (Edit), D1 (Edit), Workers KV Storage
    (Edit), and Zone -> Workers Routes (Edit) on the plrs.im zone.
  EOT
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker, D1 database and KV namespace."
  type        = string
}

variable "zone_name" {
  description = "DNS zone that hosts the Worker custom domain."
  type        = string
  default     = "plrs.im"
}

variable "zone_id" {
  description = "Cloudflare zone ID for zone_name (plrs.im). Used to attach the Worker custom domain."
  type        = string
}

variable "environment" {
  description = "Deployment environment. One of: dev, staging, prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "hostname" {
  description = <<-EOT
    Fully qualified host the Worker is served on for this environment, e.g.
    key-dev.plrs.im, key-staging.plrs.im or key.plrs.im. Must be the zone apex
    or a subdomain of zone_name.
  EOT
  type        = string
}

variable "worker_name" {
  description = "Name of the Worker script these resources are bound to (matches wrangler.toml `name`)."
  type        = string
  default     = "polaris-key"
}
