# kv.tf
#
# Workers KV namespace for this environment (the "hot" cache store). Only the
# namespace is provisioned here; the Worker binds to it by id via wrangler.toml
# ([[kv_namespaces]] -> id), which reads from outputs.tf.
#
# NOTE: in v5 the user-facing name of a KV namespace is `title` (not `name`).

resource "cloudflare_workers_kv_namespace" "hot" {
  account_id = var.cloudflare_account_id
  title      = "POLARIS_HOT_${var.environment}"
}
