# @polaris-key/manifest

## 0.1.0

### Minor Changes

- bcf402c: One channel vocabulary for the licence build gate, Release and every SDK (WIRE-CONTRACT-V3 §5.1):
  `stable`, `beta`, `pr-<n>` (a `pr` grant covers every PR), a product's manual channels, and `dev`,
  the gate's pseudo-channel for `0.0.0-dev*` builds. `staging` (the legacy spelling of `beta`) and
  `latest` (→ `stable`) stay accepted aliases that no SDK sends.

  - `@polaris-key/protocol/core` exports the vocabulary: `CHANNEL_STABLE`, `CHANNEL_BETA`,
    `CHANNEL_PR`, `CHANNEL_DEV`, `CHANNEL_ALIASES`, `CHANNEL_NAME_PATTERN`, `PR_CHANNEL_PATTERN`,
    `PR_NUMBER_MAX_DIGITS` and the `BuildChannel` type.
  - `@polaris-key/client-core`: `channelForVersion` returns `BuildChannel` and maps `0.0.0-beta*`
    and `0.0.0-staging*` to `"beta"`. **`"staging"` leaves its TypeScript return type.**
  - `@polaris-key/node` inherits the new default: a `0.0.0-staging*` or `0.0.0-beta*` build sends
    `X-PKey-Channel: beta`. Against a Worker older than this change, pass `channel: "staging"`.
  - `@polaris-key/manifest` adds two validator warnings, `noncanonical_channel_name` and
    `reserved_channel_name`, and exports `isReservedChannelName`.

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

- 415dff8: Add auto-issued free licenses and remote re-licensing.

  **Auto-issued ("always free") licenses.** A product can opt into issuing a license with no key
  and no sign-in, so software that mainly wants signed settings distribution doesn't have to gate
  every install behind a credential. `POST /<product>/enroll` mints a license bound to the
  machine's hwid and returns the same shape `/activate` does, so SDKs reuse their existing
  activation result type. One license per machine per product is enforced by a partial unique
  index, not by application logic, so concurrent first-runs converge on a single license instead
  of racing. New `enroll()` on the Node, Python, and Swift clients, plus a `pkey enroll` CLI verb.

  Enrollment requires a fingerprint: dedupe is impossible without one, and unbounded minting is
  exactly the farming case the policy exists to bound.

  **Merge on sign-in.** When a user of an auto-issued license signs in, the identity is attached
  to the _same_ license row — devices, overrides, and local client state all survive. If that
  identity already had a license, the enrolled row's devices migrate onto it and the enrolled row
  is retired. Both outcomes are audited.

  **Optional OIDC default tier.** A product can let any authenticated user who matches no IdP
  group land on the free tier instead of a hard 403. With the policy unset, behavior is
  byte-for-byte what it was.

  **Remote re-licensing.** Changing a license's tier now surfaces to clients as `license.tier` and
  `license.tierLabel` entitlements, gets its own `license.tier.change` audit entry recording
  old → new, and reports when a downgrade lands below the active device count. Existing devices
  are grandfathered; new activations are refused until the count drops.

  To make that land without a restart, all four SDKs gained an **opt-in** refresh loop
  (`refreshIntervalSeconds` / `startRefreshLoop()`) and an `onChange` callback. It is off by
  default — enabling polling would silently add network traffic and background wakeups to every
  already-shipped integration. Change detection reuses the ETag, which `computeETag()`
  deliberately makes stable across a pure re-sign, so `onChange` fires only on real content
  changes. Node and Python gained `close()` to stop the loop.

  Also fixed: `authorizeDevice` used a lexicographic string comparator where the hot path uses
  semver-correct ones from `gate.ts`.

  (Historical note: this predated wire contract v3, which split the fused document into per-service `pkey-license+jws`/`pkey-config+jws` documents and bumped `PROTOCOL_VERSION` to 3.)

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

- Updated dependencies [2baacaf]
- Updated dependencies [bcf402c]
- Updated dependencies [415dff8]
- Updated dependencies [ada5961]
- Updated dependencies [db6fb0d]
  - @polaris-key/protocol@0.1.0
  - @polaris-key/catalog@0.1.0
