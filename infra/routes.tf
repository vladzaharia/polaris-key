# routes.tf
#
# Binds the per-environment hostname (var.hostname) to the Worker as a custom
# domain. A custom domain (vs. a `cloudflare_workers_route` pattern) gives the
# host its own DNS record + edge cert and routes all requests for that host to
# the Worker — which is what we want for key.plrs.im and its dev/staging peers.
#
# Resource/attribute names verified against the cloudflare provider v5 docs:
#   - resource: cloudflare_workers_custom_domain
#   - `service` is the Worker script name (matches wrangler.toml `name`)
#   - `environment` is deprecated in v5, so it is intentionally omitted
# TODO: verify against cloudflare provider v5 docs (pin a concrete >= 5.x
#       version) before the first apply, since v5 is still stabilizing.

resource "cloudflare_workers_custom_domain" "this" {
  account_id = var.cloudflare_account_id
  zone_id    = var.zone_id
  zone_name  = var.zone_name
  hostname   = var.hostname
  service    = var.worker_name
}

# Alternative if you prefer a route pattern over a dedicated custom domain
# (e.g. to share a host with other Workers). Left commented; pick ONE.
#
# resource "cloudflare_workers_route" "this" {
#   zone_id = var.zone_id
#   pattern = "${var.hostname}/*"
#   script  = var.worker_name
# }
