# @polaris-key/protocol

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

- ada5961: Add hardware and software fingerprinting.

  Native SDKs now collect a seven-component hardware fingerprint at activation. Each component
  is hashed on the device (`pkey-hw:<product>:<component>:<raw>`), so raw serials, MAC addresses,
  and platform UUIDs never leave the machine — the server compares opaque digests only. A device
  that cannot read a component omits it rather than substituting a placeholder.

  The server soft-binds a device to its fingerprint with per-tier drift tolerance (`off` /
  `lenient` / `normal` / `strict`), so a RAM or disk upgrade does not break activation but a
  whole-machine swap does. Drift is counted asymmetrically: a component that disappears counts
  against you, a newly reported one does not, so an SDK upgrade that learns to read more
  components never looks like a hardware change.

  Clients that send no fingerprint — including every already-shipped version — keep activating
  and are recorded as `unverified`. Only a `strict` tier makes a fingerprint mandatory.

  Software facts (OS, runtime, hardware summary, locale, timezone) and product-declared
  companion-app probes ride along on the existing `POST /<product>/config/report` call. There is
  no installed-application enumeration.

  Also in this release:

  - `deviceIdFromRaw()` is exported, splitting the device-id formula from the hardware read so
    the cross-language corpus can pin it. Device-id derivation previously had no golden vector in
    any language.
  - The Swift SDK now sends an OS _family_ in `X-PKey-Platform` (`darwin`/`ios`) to match Node and
    Python, instead of a full `"Version 15.1 (Build 24B83)"` string. The detailed version moved to
    the software-facts record, where it belongs.
  - New `ActivationResult` variants `fingerprint-required` and `hardware-mismatch`.

  (Historical note: this predated wire contract v3, which split the fused document into per-service `pkey-license+jws`/`pkey-config+jws` documents and bumped `PROTOCOL_VERSION` to 3.)

  See `docs/PRIVACY.md` for exactly what is collected, why, and how long it is kept.

- db6fb0d: Initial release of the Polaris Key shared packages and SDKs: the frozen JWS wire contract
  (`@polaris-key/jws`), wire types (`@polaris-key/protocol`), the data-driven config catalog
  (`@polaris-key/catalog`), manifest tooling (`@polaris-key/manifest`), the platform CLI
  (`@polaris-key/cli`), the Node client + CLI adapters (`@polaris-key/node`), and the React
  SDK with browser-OIDC + desktop modes and a brandable login UI (`@polaris-key/react`).
