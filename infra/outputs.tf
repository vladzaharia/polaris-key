# outputs.tf
#
# These outputs feed the resource ids back into wrangler.toml for the binding
# definitions (Durable Objects, D1 and KV are bound in wrangler, not here).
# Consume them with: `terraform output -json`.

output "d1_database_id" {
  description = "D1 database id — set as [[d1_databases]].database_id in wrangler.toml."
  value       = cloudflare_d1_database.this.id
}

output "kv_namespace_id" {
  description = "Workers KV namespace id — set as [[kv_namespaces]].id in wrangler.toml."
  value       = cloudflare_workers_kv_namespace.hot.id
}

output "hostname" {
  description = "The host bound to the Worker for this environment."
  value       = var.hostname
}

output "worker_name" {
  description = "Worker script name these resources are bound to (matches wrangler.toml `name`)."
  value       = var.worker_name
}
