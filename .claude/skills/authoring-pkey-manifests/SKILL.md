---
name: authoring-pkey-manifests
description: Use when creating or editing a product's .pkey/ manifest (product, schema, release) — scaffolding with pkey init, wiring editor schema support, choosing module names, validating until clean, and registering or resyncing the product in the console.
---

# Authoring a `.pkey/` manifest

A Polaris Key product is **data, not code**: its catalog, metadata and release coordinates live
in a `.pkey/` directory in the product's own repo. Adding or changing a product must never
require a worker redeploy. `.pkey/` is the **only** manifest directory — there is no second
candidate and no fallback between two.

Reference (all now on the docs site, in the repo under `packages/docs/src/content/docs/`):
`build/manifest/authoring.md` (the `.pkey/` convention), `build/onboarding.md` (the adopter
guide), `build/registering.md` (getting a product into D1), and `start/concepts.md` (the
canonical glossary).

## Checklist

### 1. Scaffold

- [ ] Run `pkey init` in the product repo root. It creates `.pkey/` and writes YAML:
      `product.yaml` always; `schema.yaml` when the `config` module is selected; `release.yaml`
      when `releases` is selected.
- [ ] Other flags: `--admin-group`, `--release-owner`, `--release-repo`, `--force` (overwrite).
      With no `--modules`, the default is `licensing,config`.
- [ ] Do **not** hand-create the directory if `pkey init` will do it — the scaffold writes the
      `# yaml-language-server: $schema=…` header that gives you completion in the editor.

```sh
pkey init --product <slug> --name "<Name>" --modules licensing,config
```

### 2. Get editor validation working

- [ ] Scaffolded files point at a **path**, not a URL:
      `../node_modules/@polaris-key/manifest/schemas/v1/<role>.schema.json`. The canonical `$id`
      URLs (`https://key.plrs.im/docs/schemas/v1/…`) are identifiers on the auth-gated docs site,
      not fetch targets — an editor cannot retrieve them.
- [ ] In this monorepo, `.vscode/settings.json` already wires `json.schemas` and `yaml.schemas`
      for `**/.pkey/{product,schema,release}.{json,yaml,yml}` and the `products/*` fixtures. YAML
      completion needs the `redhat.vscode-yaml` extension.
- [ ] The schemas ship inside the `@polaris-key/manifest` npm package (`schemas/v1/`), so a
      product repo that installs the package gets them locally.

### 3. Know what each of the three files owns

- [ ] **`schema`** (required) — the config catalog: `{ schemaVersion, entries[] }`. Maps to the
      `product_schema` row. For an entry's fields, use the `adding-a-catalog-entry` skill.
- [ ] **`product`** (required) — product metadata, the `modules` block (enabled services),
      `devices.registration`, `web.origins`, OIDC, profiles, tiers, provisioning hooks,
      `fingerprint`, `autoIssue`, `secrets.required`. Maps to `products` (incl. `services_json`,
      `web_origins_json`) plus
      `oidc_config`, `profiles`, `tiers`, `provisioning_config`.
- [ ] **`release`** (required only when releases are enabled) — release-provider coordinates,
      channels, install/appcast settings, edge-mint recipes. Maps to `release_config` and
      `edge_mint_config`.
- [ ] The base name selects the role; the extension is a pure format preference, tried
      `.json` → `.yaml` → `.yml` and resolved **per document**, so `product.yaml` may sit next to
      `schema.json`.
- [ ] Everything here is the **manifest baseline**. Secret values, license/device overrides, live
      service toggles and operator policy overrides live in Polaris Key and survive resync.

### 4. Pick module names (both vocabularies parse)

- [ ] Canonical service slugs: `license`, `config`, `release`, `update`, `identity`. Every entry
      is `{ "enabled": <boolean> }`; anything other than literal `true` counts as off.
- [ ] The pre-suite vocabulary is still accepted and translated at ingest — only slugs are
      stored, and one block may mix both spellings (table below).
- [ ] No `modules` block (or every entry off) means `license` + `config` on, the rest off.
- [ ] `devices.registration` is optional — `open` · `requires-identity` · `requires-license`.
      Omit it to follow the services: undeclared derives `requires-license` if License is on,
      else `requires-identity` if Identity is, else `open`. Undeclared is stored as _absent_, so a
      product that later turns License off moves to the derived `open` rather than staying pinned.

| Declared    | Enables              | Why                                                                                  |
| ----------- | -------------------- | ------------------------------------------------------------------------------------ |
| `licensing` | `license`            | rename                                                                               |
| `config`    | `config`             | unchanged                                                                            |
| `releases`  | `release` + `update` | the old module meant "distributes software" — the suite splits truth store from feed |
| `oidc`      | `identity`           | rename                                                                               |
| `edgeMint`  | `config`             | edge-minting is a secret-**delivery** capability of Config, not a unit of its own    |

`pkey init --modules` takes the **old** names: `licensing,config,releases,oidc,edgeMint`.

- [ ] `web.origins` is optional: up to 16 exact browser origins that may read this product's
      device-facing routes with `fetch` (CORS, no credentials). Spell each one the way a browser
      sends `Origin`: `https://<host>[:port]`, lower-case, no default port, no path, trailing
      slash, query, credentials or wildcard. Plain `http` only for `http://localhost[:port]` and
      `http://127.0.0.1[:port]`. Bad entries are refused, never coerced (`invalid_web_origins`,
      `invalid_web_origin`). Manifest-owned: resync rewrites it and dropping the block clears it.
      Details: `packages/docs/src/content/docs/build/web-cors.md`.

### 5. Validate until clean

- [ ] `pkey validate` — parses `.pkey/`, runs the authoritative TypeScript validator, and prints
      the enabled modules, required secrets, warnings, then errors. Exit code 0 means valid.
- [ ] Fix every `error`. Common ones: `update_requires_release` (Update on with Release off — the
      feed would answer every client with an empty document), `invalid_registration_policy` (an
      unrecognised value is refused, never coerced), `reserved_slug`.
- [ ] Read the `warning` lines too. `config_without_activation` is a warning at ingest (a
      config-only product is legitimate) but the enablement API applies the same code as a hard
      error for Config on + License off + a declared `requires-license` policy, which closes the
      only mint path such a product has.
- [ ] `pkey doctor --base-url <url> --product <slug>` re-runs local validation and then checks the
      live discovery document. Without both flags the remote half is skipped.

### 6. Avoid reserved slugs

- [ ] `product.slug` must not collide with a platform route the worker matches before
      `/<product>/…`. The refused list (`RESERVED_PRODUCT_SLUGS`) is: `docs`, `manage`, `api`,
      `assets`, `login`, `logout`, `callback`, `magic`, `download`, `webhooks`, `well-known`.
      A product registered under one would be permanently shadowed; the validator emits
      `reserved_slug` and the console's manual-create path checks the same list.

### 7. Register the product

- [ ] **Repo-link (preferred).** In the console, link the product's repo. The worker fetches and
      parses the three files and registers the product, minting the sealed signing key and
      returning the public trust key. Re-linking, or a signed GitHub push webhook, re-parses and
      updates the rows; webhook sync is pinned to the pushed commit SHA, records the changed
      `.pkey/` paths, and surfaces applied sections or validation errors in the Releases view.
- [ ] **Manual create.** Product metadata plus a schema document, for early experiments. Release,
      OIDC, provisioning, profiles, tiers and edge-mint rows are configured later or by linking.
- [ ] **Seed SQL is a fixture tool only** —
      `pnpm --filter @polaris-key/products gen-seed <slug>`. It cannot mint sealed `product_keys`
      or store secret values; never use it for live onboarding.

### 8. Understand resync and ownership before you promise a behavior

- [ ] A resync updates the **manifest baseline**: product metadata, service enablement +
      registration policy, `web.origins`, fingerprint and auto-issue policy, catalog shape, OIDC baseline,
      release baseline, profiles, tiers, provisioning, edge-mint recipes.
- [ ] Admin-set **values and management states** (per profile/tier/license/device) live in D1 and
      are **not** overwritten by a resync.
- [ ] **Edge-mint recipes need operator approval.** A recipe from `.pkey/` is inert (its token
      route answers `404`) until an operator approves it in the console's Secrets view, and it
      signs only with a secret the operator marked usage `edge-mint`. The manifest can never set
      either. Changing a recipe's `alg`, `signingKeySecret`, `kid`, `claimsTemplate`,
      `ttlSeconds` or `audience` makes it inert again until it is re-approved; an unchanged
      resync keeps it approved; dropping it deletes its approval. So does a push that makes the
      mint public — opens registration (`devices.registration: open`, or License turned off) or
      enables anonymous `autoIssue` (`mode: anonymous`/`both`) — when the approval was given
      without the open-registration acknowledgement. Tell the product owner to expect a
      review step after any such push (docs: `services/config/edge-mint`).
- [ ] Five blocks are operator-claimable: `services_source`, `fingerprint_policy_source`,
      `auto_issue_source` (on the product), `compat_source` (the compat window, claimed from
      Update settings) and `access_source` (both release access modes together, on
      `release_config`). A live console edit flips the source `manifest` → `admin`, and a
      resync then **skips** that block — a push cannot silently undo a 3am toggle, nor
      downgrade an `entitled` product to the manifest's `public`. "Revert to manifest" hands
      ownership back and changes nothing else; the manifest re-applies on the **next** resync,
      not immediately.
- [ ] The operator-only artifact policy (`requireSparkleSignature`, `minimumSystemVersion`)
      has **no manifest spelling at all** — it lives in `release_config.operator_policy_json`,
      which no manifest path writes. Do not try to declare either key (or the `entitled` access
      mode) in `.pkey/release`; set them in the console's Update settings.

## Verification

```sh
pkey validate                                     # exit 0, no error lines
pkey doctor --base-url https://key.plrs.im --product <slug>

# In this monorepo, after touching the validator, the schemas, or products/<slug>:
mise exec node@22 -- pnpm --filter @polaris-key/manifest test   # incl. schema-parity
mise exec node@22 -- pnpm --filter @polaris-key/cli test
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm format
```

If you added or changed a validator rule, `schema-parity.test.ts` will fail until its mutation
table carries an entry for the new error code — that is the gate working, not a flake.
