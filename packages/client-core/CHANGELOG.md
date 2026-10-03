# @polaris-key/client-core

## 0.1.0

### Minor Changes

- 0c197bd: Add the boot stage machine, `@polaris-key/client-core/stages`: `initialBootState`, the pure
  reducer `bootTransition(state, event) → { state, emits }`, the boot guard's launch decision
  `bootGuardAction({ staged, failedBoots })` with `MAX_FAILED_BOOTS = 2`, and the five
  vocabulary lists (`BOOT_STAGES`, `BOOT_OUTCOMES`, `BOOT_EVENT_TYPES`, `BOOT_EMIT_TYPES`,
  `BOOT_GUARD_ACTIONS`). Every renderer drives the same machine, and
  `conformance/corpus/v2/stage-matrix.json` pins it in every language. Nothing on the wire
  changes, and the new API does nothing until a host calls it.
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

- 68952d9: Fix fingerprint sources and token storage, and surface where the token lives.

  **Store status.** `Store` gains an optional `status()` returning `StoreStatus`
  (`{ backend, degraded?: { reason, detail? } }`), with the `STORE_BACKENDS` and
  `STORE_DEGRADED_REASONS` vocabularies. `PolarisKeyClient.storeStatus()` reports it, and the CLI's
  `status` command prints a `Token store:` line. A `KeyringStore` that falls back to its 0600 file
  now says so (`keyring-unavailable` or `keyring-error`) instead of doing it silently (security
  finding R4-11).

  **Keyring.** `@napi-rs/keyring` moves to `^2.1.0`. On Linux every entry is pinned to the Secret
  Service: a headless host used to get the in-memory kernel keyring, which lost the token at the
  next reboot; it now gets the 0600 file and a `keyring-unavailable` status. Writes are verified by
  reading back; reads are file-first, because only a write that fell back leaves a file, so an
  older keyring token can no longer shadow a newer file token. A headless Linux host whose token
  was in the kernel keyring re-activates once.

  **Windows fingerprint.** `boardSerial` and `machineModel` are read with one PowerShell
  `Get-CimInstance` call (the same WMI properties `wmic` read, so Windows 10 sees no drift; Windows
  11 without `wmic` regains both). No console window flashes and the child's stdin is the null
  device. `parseWindowsCim()` and `WINDOWS_CIM_COMMAND` are exported.

  **Linux anchor.** `machineUuid` and the device id read `/etc/machine-id`, else
  `/var/lib/dbus/machine-id`, skipping blank and `uninitialized` files. `product_uuid` and
  `board_serial` are no longer read, so root and non-root processes agree. A root process on a
  host with a machine-id changes two components once (`normal` tolerates it; `strict` re-binds
  once). **A host with neither file — most container images — has no anchor**, so keyless
  enrolment there answers `fingerprint_required`. In a container, mount the host's
  `/etc/machine-id` read-only, or create one and keep it in a volume; never bake one into an
  image, because every container of that image would share it. A missing `/etc/machine-id` no
  longer mints a random device id when the dbus file exists. `linuxAnchorSource()` is exported.

  **`ramBucket`.** Below 1 GiB the component is omitted (it was `"0.5"`). `ramBucket(bytes)` is
  exported and integer-exact.

  **Directories.** `CoreOptions` gains `dataDir`, `cacheDir` and `stateDir` (bases; the product
  slug is appended), with platform defaults, exposed as `core.dirs`. `resolveDirs()` and
  `excludeFromBackup()` are exported. The config directory does not move, except that an empty
  `XDG_CONFIG_HOME` now means `~/.config` rather than the working directory.

- 7c03f1c: Raise the supported Node floor from 22.0.0 to 22.12.0 (`engines.node: ">=22.12.0"`). The test
  toolchain (vitest 4, rolldown) no longer runs on Node 22.0–22.11, so the floor CI job could not
  prove those versions; 22.12 is the same LTS line.

### Patch Changes

- Updated dependencies [2baacaf]
- Updated dependencies [bcf402c]
- Updated dependencies [415dff8]
- Updated dependencies [ada5961]
- Updated dependencies [db6fb0d]
  - @polaris-key/protocol@0.1.0
  - @polaris-key/jws@0.1.0
