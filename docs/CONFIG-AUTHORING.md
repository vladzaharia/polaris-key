# Authoring a product's config — the `.pkey/` convention

A Polaris Key product is **data, not code**. Its catalog, metadata, and release coordinates
live in a `.pkey/` directory in the product's own repo. The Worker, the admin SPA, and all
five SDKs read that data;
adding or changing a product never requires a Worker redeploy.

This doc is the source of truth for the `.pkey/` files and the `ConfigEntry` shape, using
**djdl** (the first product) as the worked example. The canonical terminology lives in
`docs/CONCEPTS.md`; the byte-for-byte wire contract lives in the root `README.md`.

## The `.pkey/` directory

A `.pkey/` directory holds up to **three independent files**, each in **JSON or YAML**
(detection is "try JSON first, else YAML"). The base name (no extension) selects the role.
The files are the **manifest baseline**: they describe intended product defaults. Runtime
admin changes such as secrets, license/device overrides, temporary module toggles, and
operator policy overrides live separately in Polaris and are preserved across resync.

| File        | Base name                 | Maps to                                                                             | What it carries                                                                                                     |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **schema**  | `schema.{json,yaml,yml}`  | `product_schema` row                                                                | the config catalog: `{ schemaVersion, entries[] }` (**required**)                                                   |
| **product** | `product.{json,yaml,yml}` | `products` + module baseline + `oidc_config` + `tiers` + `provisioning_config` rows | product metadata, enabled modules, OIDC, tiers, provisioning hooks (**required**)                                   |
| **release** | `release.{json,yaml,yml}` | provider-backed `release_config` + `edge_mint_config` rows                          | release provider coordinates + channel/install/appcast/edge-mint settings (required only when releases are enabled) |

In this repo the same data lives split for fixture clarity as `products/djdl/catalog.json`
(the schema) and `products/djdl/product.json` (product + release + edge-mint inlined). When
a product hosts its own `.pkey/`, `packages/worker/src/release/manifest.ts#parseManifest`
parses the files, aggregates **all** validation errors, and returns a `ParsedManifest` ready
for D1 insertion. The schema is compiled through `@polaris-key/catalog` before anything is
written so malformed JSON-Schema fragments fail during import/resync, not during a client
request.

## The catalog: `ConfigEntry`

The schema file is a `ProductCatalog`: a `schemaVersion` (bumped on incompatible shape
changes; it matches the signed doc's `schemaVersion`) and an `entries` array. Each entry is a
`ConfigEntry` (`packages/shared-catalog/src/types.ts`):

| Field                                          | Meaning                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`                                          | Dotted identifier, e.g. `run.concurrency`, `proxy.subscriptionUrl`, `polarisVpn`.                                                                                                                            |
| `kind`                                         | `config` (plaintext client setting) · `secret` (redacted, delivered to the OS keyring) · `flag` (an entitlement).                                                                                            |
| `category`, `label`, `description`             | Grouping + human copy for settings UIs.                                                                                                                                                                      |
| `schema`                                       | A Draft-07 JSON-Schema fragment Ajv validates the value against.                                                                                                                                             |
| `default`                                      | The schema-level default value (the client's last-resort fallback).                                                                                                                                          |
| `managementDefault`                            | **CONFIG only.** The management state a freshly-minted key gets if the admin doesn't override it: `default` · `enforced` · `hidden`.                                                                         |
| `secret`                                       | `true` on `secret` kinds (redacted in admin UIs).                                                                                                                                                            |
| `userGrant` / `grantLabel`                     | A `flag` shown to the user as an included capability ("Included with your license").                                                                                                                         |
| `ui`                                           | `UiHints` — `widget` (`password`/`select`/`textarea`/`switch`/`stepper`), `placeholder`, `unit`, `scopes` (admin scopes `profile`/`license`/`device`), etc. **Presentation only; never affects validation.** |
| `dependsOn`                                    | `{ key, equals }` — presentation gating (e.g. show `proxy.select` only when `proxy.enabled === true`). Does not gate value validation.                                                                       |
| `accessor`                                     | Dotted path into the client's config object (for `config`/`secret`).                                                                                                                                         |
| `appliesTo`, `examples`, `deprecated`, `since` | Optional metadata.                                                                                                                                                                                           |

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

| State          | Server doc                | Client behavior                                                                                                                                        |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`default`**  | carries a suggested value | the user/local override wins, then an env var, then the remote value, then the SDK `fallback`. **Overridable.**                                        |
| **`enforced`** | value marked enforced     | the **remote value always wins**; local + env overrides are ignored. Shown **read-only** in settings UIs (`listUserConfig` marks it `enforced: true`). |
| **`hidden`**   | value marked hidden       | enforced **and** withheld from `listUserConfig`/enumeration — still applied internally by `getConfig`.                                                 |

The env override for a key is `PKEY_CONFIG_` + the key with dots → `__`
(`run.concurrency` → `PKEY_CONFIG_run__concurrency`); the value is JSON-parsed when it
parses, else taken as a raw string. (See each SDK README for the per-language API.)

> `secret` keys follow the same management states (djdl's `proxy.subscriptionUrl` is
> `hidden`, auto-provisioned). `flag` keys are not "managed config" in this sense — they are
> entitlements read via `isEntitled`/`getEntitlements`.

## Registering + re-syncing a product

There are three ways the catalog reaches D1. Repo-link is the normal product setup path;
manual create is for early experiments; seed SQL is a fixture tool only.

1. **Repo-link (preferred).** The product hosts a `.pkey/` directory. The admin links the
   repo; the Worker fetches + `parseManifest`s the three files and registers the product.
   Re-linking or a signed GitHub push webhook re-parses and updates the rows. Webhook sync
   is pinned to the pushed commit SHA, records changed `.pkey/` paths, and surfaces applied
   sections or validation errors in the admin Releases view.
2. **Manual schema create.** The admin can create a product with metadata plus a schema
   JSON/YAML document. Polaris still mints the sealed product signing key, but release,
   OIDC, provisioning, profiles, tiers, and edge-mint rows are configured later in admin or
   by linking a repo.
3. **Seed SQL (fixture generation only).** Generate fixture SQL from the monorepo's
   `products/<slug>` files:

   ```sh
   pnpm --filter @polaris-key/products gen-seed djdl > products/djdl/seed.sql
   ```

   Do not use this for live onboarding: it cannot mint sealed `product_keys` or store
   product secret values. Normal product registration must use the admin portal so Polaris
   can mint the sealed signing key, return the public trust key, and list missing product
   secrets.

### Admin override vs re-sync

Admins set **management state + values** (per profile/tier/license/device) and operational
runtime overrides in the admin SPA. Those values live in D1 and are **not** overwritten by a
re-sync. A re-sync updates the manifest baseline from `.pkey/`: product metadata, module
defaults, catalog shape, OIDC baseline, release baseline, provisioning, and edge-mint
recipes. So the flow is:

1. Edit `.pkey/schema` in the product repo (add a key, tighten a schema, change a
   `managementDefault`); bump `schemaVersion` only on an incompatible shape change.
2. Re-link / push → the Worker re-parses and updates `product_schema`; SDKs pick up the new
   catalog at `/<product>/schema` and the next signed `/config`.
3. Existing admin value/state overrides persist; new keys take their `managementDefault`
   until an admin overrides them. The admin UI should label whether a value came from the
   manifest baseline, an admin override, a generated signing key, a configured secret, or a
   provider-discovered runtime value.

When you author a typed mirror for a product that wants compile-time config types, regenerate
it from the catalog with
`pnpm gen:mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>` (and add `--check`
in product-specific CI) — see `CONTRIBUTING.md`.
