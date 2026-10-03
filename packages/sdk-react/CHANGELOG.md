# @polaris-key/react

## 0.1.0

### Minor Changes

- 2baacaf: Canonical client metadata header values (WIRE-CONTRACT-V3 §5.2) and one config-resolution rule
  for every SDK (§2.2.1), pinned by the new `headers.json` and `config-matrix.json` corpus files.

  - `@polaris-key/protocol/core` exports `PLATFORM_SPELLINGS` and `ARCH_SPELLINGS`, every runtime
    spelling mapped to its canonical `X-PKey-Platform` / `X-PKey-Arch` value.
  - `@polaris-key/client-core` gains `canonicalPlatform` and `canonicalArch` (also the `./headers`
    subpath). Config layers read own properties only, so a key named `constructor` or `toString`
    is an ordinary key. An environment value is parsed only when it is one strict JSON text (no
    duplicate member names, no member name holding U+0000, no lone surrogate, every number zero
    or of magnitude 10^−307 up to below 10^308, at most 64 levels deep); otherwise it is the raw
    string, and reading never throws. `listUserEntries` now takes the `ResolveContext` and lists
    each document entry with its resolved value.
  - `@polaris-key/jws` exports `hasDuplicateKeys`.
  - `@polaris-key/node` sends `X-PKey-Platform`/`X-PKey-Arch` as canonical values (omitted when
    unmapped) and `X-PKey-SDK: node`; `SDK_NAME` stays the package name and is not sent.
  - `@polaris-key/react` sends `X-PKey-Platform: web` and `X-PKey-SDK: react`, and
    `listUserConfig()` no longer lists keys that only a local override supplies.

  A host relying on Swift's trailing commas, JS or Python duplicate resolution, Python's `NaN`, a
  lone surrogate, a member name holding U+0000, a number of magnitude 10^308 or more (or a
  non-zero one below 10^−307), or a value nested more than 64 deep in an environment variable now
  gets the raw string.

- 1159814: Add typed "unsupported here" (PARITY §2.2). Every client answers `supports(feature)` with
  `{ supported: true, feature }` or `{ supported: false, feature, reason, detail }`, where `reason`
  is `runtime`, `outlet`, `product`, `dependency` or `version`. The answer is read from a capability
  table generated from the SDK's `parity.json`. `caps()` lists the supported feature ids, and
  every device report now sends that list as `caps`.

  - `@polaris-key/client-core`: the shared engine (`evaluateSupport`, `supportedFeatures`,
    `detectorProblems`) and the `Supported`, `Unsupported` and `UnsupportedError` types.
    `UnsupportedError` is a `PolarisError`.
  - `@polaris-key/node`: `client.supports()` and `client.caps()`. Without a loadable OS keyring,
    `core.store` reports `dependency`. A sub-client whose service is off (Release, Update,
    Identity, the Config edge-mint) now throws `UnsupportedError` with `reason: "product"`, the
    feature and a detail. It keeps the code `service-unavailable`, so existing checks on `.code`
    still match.
  - `@polaris-key/react`: `adapter.supports()` and `adapter.caps()`, also on `usePolarisKey()`.

  **Breaking changes in `@polaris-key/react`:**

  - `getSecret()` now throws `UnsupportedError` (code `unsupported`) on both transports. It used
    to return `null`. Secrets are never delivered to a browser session or a renderer.
  - In the browser adapter, `listDevices()`, `renameDevice()`, `deauthorizeDevice()` (for another
    device) and `report()` now throw `UnsupportedError`. They keep their old `.code` values,
    `device-management-unsupported` and `report-unsupported`.
  - The public `PolarisAdapter` interface gains the required members `supports(feature)` and
    `caps()`. Custom adapters and test doubles must add them.

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
- 7c03f1c: Raise the supported Node floor from 22.0.0 to 22.12.0 (`engines.node: ">=22.12.0"`). The test
  toolchain (vitest 4, rolldown) no longer runs on Node 22.0–22.11, so the floor CI job could not
  prove those versions; 22.12 is the same LTS line.
- 6e3cd20: Close the licence, config and release parity gaps (P1b-07). Every SDK now answers the same way:

  - **`entitledChannels`** — the `channels` entitlement's string grants in order, or `["stable"]`
    when the licence carries none (the Worker's own answer). New in Node
    (`client.license.entitledChannels()`), Python (`license.entitled_channels()`) and React
    (`adapter.entitledChannels()`, `useLicense().entitledChannels`). **Swift behaviour change:**
    `LicenseClient.entitledChannels()` answered `[]` for an absent entitlement and now answers
    `["stable"]`.
  - **Catalog fetch** — `client.config.fetchSchema()` (Node: `ProductCatalog | null`; Python:
    `fetch_schema()`; React: `adapter.fetchSchema()`; Swift: `client.config.fetchSchema()`):
    `null` on any failure, never a throw, and a product without Config is not probed.
  - **Release client** — Swift gains the `PolarisKeyRelease` target (`changelog()`,
    `installURL()`, `downloadURL(version:binary:arch:checksum:dmg:)`, as `client.release`); React
    gains `adapter.changelog()` / `installUrl()` / `downloadUrl()` and `useChangelog()`
    (`@polaris-key/react/release`). A 401 or 403 now surfaces the refusal body's own code in every
    SDK (Node and Python reported a 401 as `not_found`), and a `null` changelog summary stays null
    (`ChangelogEntry.summary` is `string | null`; Python no longer turns it into `"None"`).
  - **React offline bundles** — `adapter.importBundle(jws)` and `useImportBundle()`: desktop
    through bridge protocol v3's optional `importBundle` (`BRIDGE_VERSION` is now 3), browser
    verified in-page against a random device id kept in IndexedDB (`trust: { pinnedKeys }`).
  - **Telemetry** — React desktop `adapter.report()` through `invoke("devices", "report")` (the
    browser throws `report-unsupported`); Swift exposes `PolarisKeyClient.report()`.

- a2ef102: Shared SDK constants, generated for every language by `pnpm gen:constants` (a new drift gate)
  from `conformance/parity/errors.json` and `enums.json`, the feature registry, the service table
  and `@polaris-key/protocol/core`. Both packages now export `ErrorCode` (every wire and client
  error code, with `ERROR_CODE_KINDS`), `Feature`, `UnsupportedReason`, `Platform`, `Arch`,
  `HeaderName`, `ServiceSlug` (now a value as well as a type), each with a `*_VALUES` list, and
  `PROTOCOL_VERSION`, `CORPUS_VERSION`, `GATE_MATRIX_VERSION` and `FINGERPRINT_VERSION`. No code a
  client raises or sends changes; the Python and Swift SDKs gain the same names.

### Patch Changes

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

- Updated dependencies [0c197bd]
- Updated dependencies [2baacaf]
- Updated dependencies [bcf402c]
- Updated dependencies [1159814]
- Updated dependencies [68952d9]
- Updated dependencies [415dff8]
- Updated dependencies [ada5961]
- Updated dependencies [db6fb0d]
- Updated dependencies [7c03f1c]
  - @polaris-key/client-core@0.1.0
  - @polaris-key/protocol@0.1.0
  - @polaris-key/catalog@0.1.0
