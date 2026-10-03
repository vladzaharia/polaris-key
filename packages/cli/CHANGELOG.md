# @polaris-key/cli

## 0.1.0

### Minor Changes

- d0f50c5: CI publishing (P2-02, P2-06). `pkey release publish` uploads a release's artifacts through a
  trusted-publishing ticket (GitHub Actions OIDC, single-part PUTs with `x-amz-checksum-sha256`) and
  submits its descriptor; `pkey release promote|pin|unpin|yank` manage channels; `pkey auth
github-oidc` exchanges a GitHub OIDC token for a short-lived `pkeyci_` token; `pkey manifest
schemas` prints the manifest JSON Schemas. Retries happen only on responses marked
  `retryable: true`, and a 429 on the token exchange backs off. The same code ships as the
  `polaris-key/publish` GitHub Action (`actions/publish`).
- 59564e1: Add `distribution`, the sixth opt-in service, between Release and Update. Release says what
  exists, Distribution delivers it, and Update tells a device what to do next. The chain is
  `release ← distribution ← update`. Distribution ships as a skeleton: it has no routes or outlets
  yet, so turning it on changes no device-facing behaviour today.

  **Action needed if your `.pkey/product` names `release` and `update` without `distribution`.**
  That manifest validated before this change and is now refused with `update_requires_distribution`.
  Add `distribution: { enabled: true }` to its `modules` block before the next push. Until you do,
  the product keeps serving: migration `0033_distribution_backfill` turns Distribution on for every
  product that already has Release on, so the stored state stays coherent. A manifest using the
  legacy `releases` module needs no change.

  - `@polaris-key/manifest`: `ServiceSlug` and `SERVICE_SLUGS` gain `distribution`, and
    `SERVICE_REQUIRES` gains the new edges. `MODULE_SERVICES.releases` now enables release +
    distribution + update. The validator adds two errors, `distribution_requires_release` and
    `update_requires_distribution`. It no longer emits `update_requires_release`: a manifest that
    had Update without Release now gets `update_requires_distribution`, and once Distribution is
    added, `distribution_requires_release`. The product JSON schema accepts `modules.distribution`.
  - `@polaris-key/cli`: `pkey init --modules` and `pkey validate` know the `distribution` slug. The
    scaffold does not add missing `requires` edges: `--modules release,update` writes a manifest
    that fails validation, so name `distribution` too, or use `releases`.
  - `@polaris-key/node` and `@polaris-key/react`: the exported `ServiceSlug` and `ServicesMap`
    types gain `distribution`, defaulting to off. A consumer with an exhaustive
    `Record<ServiceSlug, …>` literal must add the key.
  - Discovery (`/.well-known/polaris.json`) gains an additive `services.distribution` entry:
    `{ "enabled": false }` when off, and `{ "enabled": true, "configured": false, "endpoints": {} }`
    when on. Nothing else in the document changes, and older SDKs ignore the unknown slug.
  - `@polaris-key/worker`: Core gains descriptor hooks through which Release offers its catalog and
    Distribution its delivery state to the services that consume them. A hook whose provider is off
    answers `null`.
  - `@polaris-key/admin`: the console's service list and enablement card show Distribution, and a
    new Distribution view shows whether the release, distribution and update chain is coherent for
    the product.

- db6fb0d: Initial release of the Polaris Key shared packages and SDKs: the frozen JWS wire contract
  (`@polaris-key/jws`), wire types (`@polaris-key/protocol`), the data-driven config catalog
  (`@polaris-key/catalog`), manifest tooling (`@polaris-key/manifest`), the platform CLI
  (`@polaris-key/cli`), the Node client + CLI adapters (`@polaris-key/node`), and the React
  SDK with browser-OIDC + desktop modes and a brandable login UI (`@polaris-key/react`).
- fb56b28: Fix the `pkey init` scaffold and the validate/link disagreement.

  `@polaris-key/manifest` exports `validateIngestDocuments`, the one rule for document presence:
  `.pkey/schema` is required at ingest even when Config is off (`missing_schema`), and
  `parseManifest` and `pkey validate` both use it, so a manifest that validates now links. A new
  warning, `tier_ignored_field`, flags a tier `deviceLimit` (ignored; use `policyDeviceLimit`) and
  a tier `maxOfflineDays` (sets the licence expiry, `policyExpiryDays`, not offline grace).

  `pkey init` always writes `schema.yaml` (an empty catalog when `config` is not selected), scaffolds
  the tier as `policyDeviceLimit: 5` with no expiry, and drops the unread
  `licensing.keyActivation`. `pkey doctor` prints the enabled services from the discovery
  document's `services` block.

  Existing products created with the old scaffold have tiers with `maxOfflineDays: 14`, which
  expire their licences after 14 days: the new warning is how their owners find out. Replace
  `maxOfflineDays` with `policyExpiryDays` (or drop it for a non-expiring tier) and `deviceLimit`
  with `policyDeviceLimit`.

  Ingest behaviour for Config-off products is unchanged: a present catalog is only required to
  normalise, its content is still shape-validated only when Config is on.

- f524aa6: The opt-in services are now declared once, in a service table (`tools/services.json`), and every
  language's slug constants are generated from it (`pnpm gen:services`; `-- --check` is a new drift
  gate). No wire shape changes: the discovery document is byte-identical.

  - `@polaris-key/manifest` additionally exports `DEFAULT_ENABLED_SERVICES`, `MODULE_SERVICES`,
    `SERVICE_REQUIRES` and the `LegacyModule` type, generated from the table. The table itself
    leaves `ServiceSlug`, `SERVICE_SLUGS` and `ProductModule` unchanged; the `distribution-service`
    changeset adds the sixth slug.
  - `@polaris-key/cli`: `pkey init --modules` accepts the service slugs (`license`, `config`,
    `release`, `update`, `identity`) as well as the legacy module names, and the scaffold now
    writes the `modules` block in service slugs, one line per service. `normalizeModules` returns
    the service slugs the list enables, in canonical order, and the exported `ProductModule` type
    is the manifest package's (both vocabularies).
  - `@polaris-key/node` and `@polaris-key/react` build their service maps from the generated
    constants; behaviour and exports are unchanged.

### Patch Changes

- Updated dependencies [0c197bd]
- Updated dependencies [2baacaf]
- Updated dependencies [bcf402c]
- Updated dependencies [1159814]
- Updated dependencies [59564e1]
- Updated dependencies [68952d9]
- Updated dependencies [415dff8]
- Updated dependencies [ada5961]
- Updated dependencies [db6fb0d]
- Updated dependencies [7c03f1c]
- Updated dependencies [fb56b28]
- Updated dependencies [f524aa6]
  - @polaris-key/client-core@0.1.0
  - @polaris-key/protocol@0.1.0
  - @polaris-key/jws@0.1.0
  - @polaris-key/manifest@0.1.0
