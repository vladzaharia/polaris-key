# Polaris Key — Infrastructure (Terraform)

Declarative Cloudflare resources for `key.plrs.im` and its `dev`/`staging` peers. This
manages **D1**, **KV**, and the **Worker custom domain** only — the Durable Object
(`HubDO`) binds via `wrangler.toml`, and the Worker script itself is deployed by wrangler
(CI). Terraform owns resource *identity* (database/namespace ids) so they survive redeploys
and feed `wrangler.toml` via `terraform output -json`.

## Prerequisites (one-time, manual)

1. A Cloudflare account and the **`plrs.im`** zone active in it.
2. A Cloudflare **API token** with scopes: Workers Scripts (Edit), D1 (Edit), Workers KV
   Storage (Edit), Zone → Workers Routes (Edit) on `plrs.im`.
3. The account id and `plrs.im` zone id (Cloudflare dashboard) → fill the `REPLACE_ME_*`
   placeholders in `envs/<env>.tfvars`.

The API token is supplied out-of-band, never in a tfvars file:

```sh
export TF_VAR_cloudflare_api_token="<token>"
```

## State backend

`backend.tf` defaults to **local** state so `terraform init -backend=false` + `validate`
work without credentials. Before real use, switch to the documented R2 (S3-compatible) or
Terraform Cloud backend in `backend.tf`.

## Commands

```sh
cd infra
terraform init
terraform plan  -var-file=envs/dev.tfvars      # or staging.tfvars / prod.tfvars
terraform apply -var-file=envs/prod.tfvars      # creates D1 + KV + custom domain
terraform output -json                          # ids consumed by wrangler.toml
```

`terraform output -json` exposes `d1_database_id`, `kv_namespace_id`, `hostname`, and
`worker_name`; wire `d1_database_id` / `kv_namespace_id` into the corresponding
`[env.<env>]` block of the Worker's `wrangler.toml` before `wrangler deploy`.

## Notes / TODO

- The Cloudflare provider **v5** is still stabilizing; resource/attribute names (esp.
  `cloudflare_workers_custom_domain`) carry `# TODO: verify against v5 docs` comments —
  confirm and pin a concrete `~> 5.x` version before the first `apply`.
- Never commit real account/zone ids or the API token.
