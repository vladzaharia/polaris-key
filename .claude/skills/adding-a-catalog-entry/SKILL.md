---
name: adding-a-catalog-entry
description: Use when adding or changing a key in a product's config catalog (.pkey/schema or products/<slug>/catalog.json) — choosing config vs secret vs flag, writing the Draft-07-subset schema fragment, picking managementDefault or delivery, deciding whether to bump schemaVersion, and publishing.
---

# Adding a catalog entry

A product's config catalog is the `schema` document of its `.pkey/` manifest: a `schemaVersion`
plus one `ConfigEntry` per declarable key. It is **data** — never add a product-specific key to
worker or SDK code.

Reference: `packages/docs/src/content/docs/build/manifest/authoring.md` (the `.pkey/` convention,
formerly `docs/CONFIG-AUTHORING.md`), `packages/shared-catalog/src/types.ts`, and the generated
field table at `packages/docs/src/content/docs/reference/config-entry.mdx`.

## Checklist

### 1. Pick the kind

- [ ] **`config`** — a plaintext client setting. Rides the config document, resolved through the
      client precedence chain, overridable unless management says otherwise.
- [ ] **`secret`** — redacted in admin UIs, delivered to the OS keyring rather than the plaintext
      config map. Set `"secret": true` alongside.
- [ ] **`flag`** — an entitlement. Flags ride the **license** document only and are read with
      `isEntitled` / `getEntitlements`; they are not "managed config". A config-only product has
      no flags in play.

### 2. Write the entry

- [ ] `key` — dotted identifier, unique in the catalog, matching `^[A-Za-z0-9._:-]{1,64}$`
      (`run.concurrency`, `proxy.subscriptionUrl`, `polarisVpn`).
- [ ] `category`, `label`, `description` — grouping and human copy for settings UIs.
- [ ] `default` — the schema-level default; the client's last-resort fallback.
- [ ] `ui` — `widget` (`password` · `select` · `textarea` · `switch` · `stepper`), `placeholder`,
      `unit`, `help`, `order`, `scopes` (admin scopes `profile` · `license` · `device`).
      **Presentation only; never affects validation.**
- [ ] `dependsOn: { key, equals }` — presentation gating only. It does **not** gate value
      validation.
- [ ] `accessor` — dotted path into the client's config object (`config` / `secret` kinds).
- [ ] `userGrant` / `grantLabel` — a `flag` shown to the user as an included capability.
- [ ] Optional metadata: `appliesTo`, `examples`, `deprecated`, `since`.

### 3. Write the `schema` fragment — a Draft-07 **subset**

- [ ] The entry's own `schema` field is a nested JSON-Schema fragment that values must satisfy.
      Do not confuse it with the document-level `.pkey/schema` file: two different layers.
- [ ] The validator (`packages/shared-catalog/src/validate.ts`) **interprets** the schema instead
      of compiling it, because workerd forbids code generation from strings outside the startup
      window and catalogs are read from D1 during a request. Ajv would throw `EvalError` on every
      config poll.
- [ ] **Fail-closed keyword policy.** A keyword this validator does not implement makes the
      fragment _unsupported_, never "ignored": it is a **422 at publish time**, and at request
      time the value is marked invalid and pruned before signing. Silently skipping an
      unrecognised constraint would let an operator believe a value is bounded when it is not.
- [ ] Assertion keywords supported: `type`, `enum`, `const`, `minimum`, `maximum`,
      `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`,
      `format`, `items`, `additionalItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`,
      `properties`, `required`, `additionalProperties`, `patternProperties`, `propertyNames`,
      `minProperties`, `maxProperties`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`.
- [ ] Annotation keywords are inert (carried, no effect): `$schema`, `$id`, `$comment`, `title`,
      `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `definitions`,
      `$defs`, `contentMediaType`, `contentEncoding`.
- [ ] `format` values supported: `uri`, `url`, `uri-reference`, `iri`, `email`, `hostname`,
      `ipv4`, `ipv6`, `date`, `time`, `date-time`, `uuid`, `json-pointer`, `regex`. Any other
      format name makes the schema unsupported.
- [ ] `$ref` is **not** in the supported set. Inline the constraint.
- [ ] `pattern` / `patternProperties` are matched by a linear-time engine, not the host `RegExp`.
      A pattern it cannot compile is unsupported.
- [ ] Structural limits: depth ≤ 12, ≤ 500 subschemas per fragment.

### 4. Choose `managementDefault` (config kinds only)

The management state a freshly-minted key gets when an admin has not overridden it per
tier/license/device. The client precedence is
`enforced|hidden (remote) > local override > environment > remote default > fallback`.

| Value      | Client behavior                                                                           | Choose it when                                                                 |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `default`  | user/local override wins, then env, then the remote value, then the SDK fallback          | the key is a user preference the server merely suggests                        |
| `enforced` | the remote value always wins; local + env ignored; shown **read-only** in settings UIs    | policy the operator must be able to dictate (limits, endpoints, kill switches) |
| `hidden`   | `enforced` **and** withheld from `listUserConfig` / enumeration; still applied internally | the user must not see or reason about the value at all                         |

The env override for a key is `PKEY_CONFIG_` + the key with dots → `__`
(`run.concurrency` → `PKEY_CONFIG_run__concurrency`), JSON-parsed when it parses.

### 5. Choose `delivery` (secret kinds only)

- [ ] `serverOnly` — never leaves the worker.
- [ ] `clientScoped` — delivered to the device keyring.
- [ ] `edgeMint` — minted on demand at `/<product>/config/mint/<id>/{token,auth}`. Edge-minting
      is a Config **capability**, not a service; the recipe (alg, claims template, key, audience)
      lives in `.pkey/release`.
- [ ] `delivery` on a non-`secret` entry is a validation error. `managementDefault` and `delivery`
      are not interchangeable — one is enforcement, the other is transport.

### 6. Decide whether to bump `schemaVersion`

- [ ] Bump **only on an incompatible shape change**. Adding a key, tightening copy, or changing a
      `managementDefault` is not one.
- [ ] The value is the _product's_ schema version, not the wire's, and it is echoed in the signed
      config document, so a bump is visible to every client.
- [ ] Existing admin value/state overrides persist across a publish; new keys take their
      `managementDefault` until an admin overrides them.

### 7. Publish

- [ ] **Console (`Catalog → Publish new version`)** — seeds a JSON editor from the active catalog
      with `schemaVersion` pre-incremented, validates on every keystroke, and calls
      `publishSchema`. Correct the pre-increment back if this is not an incompatible change.
- [ ] **Push `.pkey/schema`** — for a repo-linked product, commit and push the manifest; the
      signed GitHub webhook re-parses and updates `product_schema`. This is the normal path, and
      it keeps the repo the source of truth. A console publish is the out-of-band one.
- [ ] Either way the catalog is compiled through `@polaris-key/catalog` **before** anything is
      written, so a malformed fragment fails at publish/import rather than during a client
      request.

### 8. How clients pick it up

- [ ] Public catalog: `GET /<product>/config/schema`. Signed values: the next
      `GET /<product>/config/document` (`pkey-config+jws`), which carries `config`, `secrets` and
      the catalog's `schemaVersion`.
- [ ] Nothing is pushed. A running client sees the change on its next `sync()`; ETag/`304` means
      an unchanged catalog costs nothing.
- [ ] For a product that wants compile-time config types, regenerate its typed mirrors:
      `pnpm gen:mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>` (add `--check` in that
      product's CI).

## Verification

```sh
pkey validate                                                    # if editing a .pkey/ repo

mise exec node@22 -- pnpm --filter @polaris-key/manifest test    # catalog shape + schema parity
mise exec node@22 -- pnpm --filter @polaris-key/catalog test     # keyword/format support
mise exec node@22 -- pnpm --filter @polaris-key/worker test      # config document + publish path
mise exec node@22 -- pnpm format
```

A fragment that publishes fine but fails at request time means a keyword slipped past — check it
against the supported list in step 3 rather than loosening the validator.
