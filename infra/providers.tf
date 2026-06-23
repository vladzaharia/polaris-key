# providers.tf
#
# Terraform + Cloudflare provider configuration for Polaris Key (key.plrs.im).
#
# We pin to the MODERN cloudflare/cloudflare provider v5.x. Note that v5 was a
# large, breaking rewrite of v4 (resource names + schemas changed), so all
# resources in this module use the v5 shapes. Do not downgrade to v4 without
# rewriting the resources.

terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# The provider is configured entirely from variables; secrets (the API token)
# are sourced from variables (typically TF_VAR_cloudflare_api_token) and never
# hardcoded here. See variables.tf and the README.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
