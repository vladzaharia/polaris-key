# Authoring a product's config — the `.pkey/` convention

A Polaris Key product is **data, not code**. Its catalog, metadata, and release coordinates
live in a `.pkey/` directory in the product's own repo (or are supplied inline when an admin
creates the product by hand). The Worker, the admin SPA, and all five SDKs read that data;
adding or changing a product never requires a Worker redeploy.

This doc is the source of truth for the `.pkey/` files and the `ConfigEntry` shape, using
**djdl** (the first product) as the worked example. The canonical terminology lives in
`docs/CONCEPTS.md`; the byte-for-byte wire contract lives in the root `README.md`.

## The `.pkey/` directory

A `.pkey/` directory holds up to **three independent files**, each in **JSON or YAML**
(detection is "try JSON first, else YAML"). The base name (no extension) selects the role:

| File | Base name | Maps to | What it carries |
|------|-----------|---------|-----------------|
| **schema** | `schema.{json,yaml,yml}` | `product_schema` row | the config catalog: `{ schemaVersion, entries[] }` (**required**) |
| **product** | `product.{json,yaml,yml}` | `products` + `oidc_config` + `tiers` + `provisioning_config` rows | product metadata, OIDC, tiers, provisioning hooks (**required**) |
| **release** | `release.{json,yaml,yml}` | `release_config` + `edge_mint_config` rows | GitHub release coordinates + edge-mint signers (optional) |

In this repo the same data lives split for clarity as `products/djdl/catalog.json` (the
schema) and `products/djdl/product.json` (product + release + edge-mint inlined). When a
product hosts its own `.pkey/`, `packages/worker/src/release/manifest.ts#parseManifest`
parses the three files, aggregates **all** validation errors, and returns a `ParsedManifest`
ready for D1 insertion (the schema is compiled through `@polaris-key/catalog` to reject a
malformed JSON-Schema fragment before anything is written).

## The catalog: `ConfigEntry`

The schema file is a `ProductCatalog`: a `schemaVersion` (bumped on incompatible shape
changes; it matches the signed doc's `schemaVersion`) and an `entries` array. Each entry is a
`ConfigEntry` (`packages/shared-catalog/src/types.ts`):

| Field | Meaning |
|-------|---------|
| `key` | Dotted identifier, e.g. `run.concurrency`, `proxy.subscriptionUrl`, `polarisVpn`. |
| `kind` | `config` (plaintext client setting) · `secret` (redacted, delivered to the OS keyring) · `flag` (an entitlement). |
| `category`, `label`, `description` | Grouping + human copy for settings UIs. |
| `schema` | A Draft-07 JSON-Schema fragment Ajv validates the value against. |
| `default` | The schema-level default value (the client's last-resort fallback). |
| `managementDefault` | **CONFIG only.** The management state a freshly-minted key gets if the admin doesn't override it: `default` · `enforced` · `hidden`. |
| `secret` | `true` on `secret` kinds (redacted in admin UIs). |
| `userGrant` / `grantLabel` | A `flag` shown to the user as an included capability ("Included with your license"). |
| `ui` | `UiHints` — `widget` (`password`/`select`/`textarea`/`switch`/`stepper`), `placeholder`, `unit`, `scopes` (admin scopes `profile`/`license`/`device`), etc. **Presentation only; never affects validation.** |
| `dependsOn` | `{ key, equals }` — presentation gating (e.g. show `proxy.select` only when `proxy.enabled === true`). Does not gate value validation. |
| `accessor` | Dotted path into the client's config object (for `config`/`secret`). |
| `appliesTo`, `examples`, `deprecated`, `since` | Optional metadata. |

### djdl examples

```jsonc
// config — overridable by default
{ "key": "run.concurrency", "kind": "config", "category": "Run",
  "label": "Parallel downloads", "schema": { "type": "integer", "minimum": 1, "maximum": 8 },
  "default": 3, "managementDefault": "default", "ui": { "widget": "stepper" } }

// secret — withheld from enumeration, auto-provisioned from the IdP
{ "key": "proxy.subscriptionUrl", "kind": "secret", "secret": true, "category": "VPN",
  "label": "VPN subscription URL", "schema": { "type": "string", "format": "uri" },
  "managementDefault": "hidden", "ui": { "widget": "password" },
  "dependsOn": { "key": "polarisVpn", "equals": true } }

// flag — an entitlement the user sees as an included capability
{ "key": "polarisVpn", "kind": "flag", "category": "VPN", "label": "Polaris VPN",
  "schema": { "type": "boolean" }, "default": false,
  "userGrant": true, "grantLabel": "Polaris VPN", "ui": { "widget": "switch" } }
```

## How `default` / `enforced` / `hidden` behave end-to-end

`managementDefault` seeds the per-key **management state** when a key is minted; an admin can
override it per tier/license/device. The Worker stamps the effective state onto each
`ManagedEntry` in the signed doc. On the **client**, the SDKs resolve a value through one
fixed precedence:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

| State | Server doc | Client behavior |
|-------|-----------|-----------------|
| **`default`** | carries a suggested value | the user/local override wins, then an env var, then the remote value, then the SDK `fallback`. **Overridable.** |
| **`enforced`** | value marked enforced | the **remote value always wins**; local + env overrides are ignored. Shown **read-only** in settings UIs (`listUserConfig` marks it `enforced: true`). |
| **`hidden`** | value marked hidden | enforced **and** withheld from `listUserConfig`/enumeration — still applied internally by `getConfig`. |

The env override for a key is `PKEY_CONFIG_` + the key with dots → `__`
(`run.concurrency` → `PKEY_CONFIG_run__concurrency`); the value is JSON-parsed when it
parses, else taken as a raw string. (See each SDK README for the per-language API.)

> `secret` keys follow the same management states (djdl's `proxy.subscriptionUrl` is
> `hidden`, auto-provisioned). `flag` keys are not "managed config" in this sense — they are
> entitlements read via `isEntitled`/`getEntitlements`.

## Registering + re-syncing a product

There are three ways the catalog reaches D1; all share the same validated shape.

1. **Repo-link (preferred).** The product hosts a `.pkey/` directory. The admin links the
   repo; the Worker fetches + `parseManifest`s the three files and registers the product.
   Re-linking (or a webhook on push) re-parses and updates the rows.
2. **Manual create.** Paste the same JSON/YAML into the admin "create product" form (handy
   before a repo exists). Internally this runs the same `parseManifest`.
3. **Seed SQL (bootstrap / this monorepo).** Generate the D1 seed from the data files and
   apply it:

   ```sh
   pnpm --filter @polaris-key/products gen-seed products/djdl > products/djdl/seed.sql
   wrangler d1 execute polaris_key_prod --remote --file products/djdl/seed.sql
   ```

   `products/gen-seed.ts` compiles the catalog (failing on a bad schema fragment) before
   emitting `INSERT`s for `products`, `product_schema`, `oidc_config`, `tiers`,
   `provisioning_config`, `edge_mint_config`, and `release_config`.

### Admin override vs re-sync

Admins set **management state + values** (per tier/license/device) in the admin SPA — those
overrides live in D1 and are **not** overwritten by a re-sync. A re-sync only updates the
**catalog shape** (entries, schemas, defaults) from `.pkey/`. So the flow is:

1. Edit `.pkey/schema` in the product repo (add a key, tighten a schema, change a
   `managementDefault`); bump `schemaVersion` only on an incompatible shape change.
2. Re-link / push → the Worker re-parses and updates `product_schema`; SDKs pick up the new
   catalog at `/<product>/schema` and the next signed `/config`.
3. Existing admin value/state overrides persist; new keys take their `managementDefault`
   until an admin overrides them.

When you author a typed mirror for a product that wants compile-time config types, regenerate
it from the catalog with `tools/gen-mirrors.ts` (and `--check` in CI) — see
`CONTRIBUTING.md`.
