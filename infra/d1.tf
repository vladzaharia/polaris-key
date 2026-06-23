# d1.tf
#
# D1 database for this environment. The Worker binds to it by id via
# wrangler.toml ([[d1_databases]] -> database_id); that id is surfaced in
# outputs.tf, so binding is NOT managed here.

resource "cloudflare_d1_database" "this" {
  account_id = var.cloudflare_account_id
  name       = "polaris_key_${var.environment}"

  # Keep replicas/jurisdiction at provider defaults; add `primary_location_hint`
  # or `read_replication` here if a region pin becomes necessary.
}
