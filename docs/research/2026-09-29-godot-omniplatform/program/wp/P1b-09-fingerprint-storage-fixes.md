# P1b-09 Fix fingerprint and storage issues: `wmic`, Linux anchor, config directories, keyring downgrade, macOS keychain

| Field       | Value                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                                                                                                                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                    |
| Depends on  | [P1b-01](P1b-01-parity-registry.md)                                                                                                                                                                                                                                                     |
| Unblocks    | [P4-06](P4-06-client-core-packs.md), [P4-07](P4-07-python-swift-packs.md), [X-02](X-02-tauri-plugin.md)                                                                                                                                                                                 |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                    |
| Plan mode   | **yes**: `program/plans/P1b-09.md` needs human approval before any code (it changes `fingerprint.json` and the `client-core` `Store` contract)                                                                                                                                          |
| Gates       | plan mode; the corpus drift gate for `fingerprint.json` (`pnpm gen:corpus -- --check`, the mirrors (Swift, Godot)); all SDKs; AGENTS rule 7 and `docs/PRIVACY.md`; the generated `reference/corpus.mdx` page (it prints vector counts); one corpus-touching package in flight at a time |
| Human input | approval of the plan, including the Linux-anchor migration impact and the config-directory choice                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                               |

## Goal

After an approved plan:

- Windows 11 fingerprints read `boardSerial` and `machineModel` again, with the same values
  `wmic` produced on Windows 10.
- Linux fingerprints no longer depend on the process's privilege.
- Node, Python and Swift offer platform-correct data, cache and state directories with backup
  exclusion, which packs need.
- A token store that falls back from the OS keyring to a file says so, through a surfaced store
  status.
- Swift's macOS keychain honours its accessibility attribute, or reports why it cannot.
- `ramBucket` agrees across SDKs below 1 GiB.
- New `fingerprint.json` sections pin every derivation that can be pure, and the Node, Python, Swift
  and Worker runners pass them.

## Why

Five issues in [README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot)
(#23–#27), found in
[notes/E9 §12](../../notes/E9-runtime-building-blocks.md#12-observations-about-the-current-sdks-worth-fixing-regardless-of-new-runtimes),
plus the `ramBucket` half of #17. Each weakens a guarantee without any signal:

- two fingerprint components silently vanish on Windows 11;
- strict-tier Linux bindings flip when root and non-root processes alternate;
- tokens land in a 0600 file without notice;
- the macOS keychain's at-rest policy is weaker than documented.

Packs (P4) need proper data and cache directories
([notes/E9 §5.3](../../notes/E9-runtime-building-blocks.md#53-app-data-directories)).

## Read first

- `AGENTS.md` (rules 1, 2 and 7), `CLAUDE.md`, `program/plans/README.md`, `docs/PRIVACY.md:30-44`.
- notes/E9: [§5](../../notes/E9-runtime-building-blocks.md#5-atomic-file-replace-locking-and-app-data-directories),
  [§6](../../notes/E9-runtime-building-blocks.md#6-secure-storage),
  [§12](../../notes/E9-runtime-building-blocks.md#12-observations-about-the-current-sdks-worth-fixing-regardless-of-new-runtimes),
  [§13](../../notes/E9-runtime-building-blocks.md#13-spikes-and-open-questions) items 8–9.
- [PARITY §5.1](../../PARITY.md#51-core) (`core.store` footnotes) and
  [§5.4](../../PARITY.md#54-devices-and-identity).
- Fingerprint reads:
  - Node: `packages/sdk-node/src/devices/fingerprint.ts` (`ramBucket` `:62-66`, `win32Components`
    `:116-146`, `linuxComponents` `:160-176`) and `devices/deviceId.ts`;
  - Python: `sdks/python/src/polaris_key/devices/fingerprint.py` (`_ram_bucket` `:119-130`, the
    Windows reads `:188-199`, `_linux_components` `:210-220`) and `devices/deviceid.py:71`;
  - Swift: `sdks/swift/Sources/PolarisKeyCore/Fingerprint.swift:118-124`.
- The server matcher: `packages/worker/src/fingerprint.ts:95-178` (`computeEnrollHwid`,
  `matchFingerprint`: newly present components do not count, the anchor bonus) and
  `packages/worker/src/core/devices.ts:228-275` (a mismatch retires and re-authorises the binding).
- Stores:
  - `packages/client-core/src/store.ts:56-64` (`Store`);
  - Node `packages/sdk-node/src/core/store.ts:139-210` (`loadKeyring`, `KeyringStore`) and
    `core/context.ts:96-98` (`defaultConfigDir`);
  - Python `sdks/python/src/polaris_key/devices/store.py:170-231` and `core/context.py:125-128`;
  - Swift `sdks/swift/Sources/PolarisKeyCore/Store.swift:213-284` (`defaultConfigDir`, `setToken`)
    and `PolarisKey/PolarisKeyClient.swift:363` (`storeFailure()`).
- The corpus generator: `tools/sign-corpus.ts:3657-4305` (the fingerprint helpers at `:3657`,
  P1b-09's derivation sections and their self-check at `:3747-4173`, then
  `buildFingerprintCorpus` at `:4175`; `main()` at `:4308`; re-anchored after P1-01 moved the
  file); the runners
  `conformance/runners/node/fingerprint.test.ts`, `sdks/python/tests/test_fingerprint_conformance.py`,
  `sdks/swift/Tests/PolarisKeyTests/FingerprintConformanceTests.swift`,
  `packages/worker/test/fingerprintCorpus.test.ts`.

## Scope

**In** (the plan decides each item; the implementation follows it):

1. The `wmic` replacement in Node and Python.
2. The Linux anchor in Node and Python.
3. Data, cache and state directories in Node, Python and Swift.
4. A surfaced store status: an optional `Store.status()` in `client-core`, implemented in Node,
   Python and Swift; the `@napi-rs/keyring` upgrade.
5. The macOS data-protection keychain in Swift.
6. `ramBucket` below 1 GiB in Node.
7. `fingerprint.json` gains derivation sections (below), with the mirrors (Swift, Godot), runner updates in
   Node, Python, Swift and the Worker, and a regenerated `reference/corpus.mdx`.
8. `docs/PRIVACY.md`'s component-source table, and the SDK docs pages for the directories and the
   store status.
9. Manifests: `devices.fingerprint` and `core.store` move to `implemented` where the plan closes them.

**Out** (and where it belongs instead):

- A new fingerprint component, for example `product_uuid` as its own optional component. That
  changes `FINGERPRINT_COMPONENTS` in `shared-protocol`, a wire change needing a `PROTOCOL_VERSION`
  bump (AGENTS rule 2). Not here.
- Extracting the keyring addon from a Node single-executable build to a temporary file
  (notes/E9 §13 item 9 is still a spike).
- Using the new directories for packs (→ [P4-06](P4-06-client-core-packs.md),
  [P4-07](P4-07-python-swift-packs.md)); Godot's reads (→ [P1-05](P1-05-godot-devices.md), which
  follows these rules); capability telemetry for a degraded store (`core.caps`, unowned).

## Design notes

**1. `wmic`.** Node (`fingerprint.ts:131,143`) and Python (`fingerprint.py:194,196`) shell out to
`wmic`, which KB5067470 removed from Windows 11.

- **Recommend one PowerShell call** (`-NoProfile -NonInteractive`) that reads
  `Win32_BaseBoard.SerialNumber` and `Win32_ComputerSystem.Model` through `Get-CimInstance` and
  prints JSON.
- These are the same WMI properties `wmic … get` read, so Windows 10 devices see no drift. Windows 11
  devices gain two components, which the matcher ignores ("newly present does not count").
- Measure the PowerShell cold start against the 2-second `run` timeout.
- `GetSystemFirmwareTable("RSMB")` needs native code in Node (notes/E9 §13 item 8), so it is the
  alternative, not the default.
- Pin the output parser (trimming, empty value omitted, placeholder strings kept as `wmic` returned
  them) in a `windowsCim` corpus section.

**2. Linux anchor.** Both SDKs read `machineUuid` from `/sys/class/dmi/id/product_uuid` (root-only, 0400) before `/etc/machine-id`, and read `board_serial` (0400) too.

- **The research overstates the impact.** README #24 says one machine "counts as two devices", but
  the device id already derives from `/etc/machine-id` in both SDKs (Node `devices/deviceId.ts`,
  Python `devices/deviceid.py:71`), so the device is the same.
  (Correction, P1b-09 plan: Node reads `/var/lib/dbus/machine-id` only when `/etc/machine-id` is
  empty. When it is missing, Node falls back to a random UUID, and an empty dbus file hashes the
  empty string. Where a machine-id file is readable, root and non-root still derive the same id,
  because those files are world-readable.)
- What differs by privilege is the fingerprint. Root adds `boardSerial` and a different
  `machineUuid`, so a strict-tier binding is retired and re-authorised whenever root and non-root
  alternate (`core/devices.ts:246-275`).
- **Recommend `machineUuid` from `/etc/machine-id`, then `/var/lib/dbus/machine-id`, never
  `product_uuid`; and do not read `board_serial` on Linux.**
- The cost: `machine-id` is per OS install, which is why the code comments call it only a fallback,
  so a reinstall changes the anchor. The device id already has that property.
- The migration: a device that ran as root changes two components once. `normal` tolerates two;
  `strict` mismatches once and rebinds through the normal seat check. The plan states this, and the
  SDK changelogs repeat it.
  (Correction, P1b-09 plan §7 and D3: on a host with no usable machine-id, which includes most
  container images, a root process loses the anchor rather than changing it. Keyless enrolment
  there then answers 403 `fingerprint_required`, because `computeEnrollHwid` returns `null`
  without an anchor (`packages/worker/src/services/license/enroll.ts:207-214`).)
- Pin the source-selection rule in a `linuxAnchor` section: which readable files give which anchor.

**3. Directories.** `defaultConfigDir()` is `XDG_CONFIG_HOME` or `~/.config` on every OS in Node
(`context.ts:96`) and Python (`context.py:125`; README #25 says only Node honours `XDG_CONFIG_HOME`,
but Python does too), and `~/.config` on macOS in Swift by design (`Store.swift:213-222`).

- **Recommend keeping the config directory where it is.** It holds the token, the device id and
  `managed.json`, and a developer's Node, Python and Swift tools share it (notes/E9 §12 item 3).
  Moving it without migration loses tokens.
- **Add `dataDir`, `cacheDir` and `stateDir`** options and defaults per notes/E9 §5.3:
  - Node and Python: XDG on Linux, `~/Library/Application Support` and `~/Library/Caches` on macOS,
    `%LOCALAPPDATA%` on Windows, all hand-rolled rather than new dependencies;
  - Swift: `applicationSupportDirectory` and `cachesDirectory`;
  - a backup-exclusion helper (Apple `isExcludedFromBackup`).
- Moving the config directory itself, with a one-time migration, is an open question for the human.

**4. Store status.**

- Node's `KeyringStore` swallows every keyring failure and uses the file (`store.ts:139-210`). Inside
  a Node single-executable build the addon cannot load at all.
  (Correction, P1b-09 plan: on Linux without a Secret Service, `@napi-rs/keyring` does not fail.
  Since 1.1.2, and in the locked 1.3.0, it falls back to the kernel keyring (keyutils), which is
  in memory and does not survive a reboot, and `setToken` then deletes the file copy.)
- Python's `KeyringStore` does the same when the optional `keyring` extra is missing.
- **Recommend** an optional `status(): Promise<StoreStatus>` on the `client-core` `Store` interface:

  ```text
  StoreStatus = {
    backend: "keyring" | "keychain" | "file" | "memory" | "indexeddb";
    degraded?: { reason: "keyring-unavailable" | "keyring-error" | "legacy-keychain"; detail?: string };
  }
  ```

- Clients expose it: Node `client.storeStatus()`, Python `store_status()`, and Swift maps it beside
  `storeFailure()`.
- Detect a single-executable build with `node:sea`'s `isSea()`.
- Bump the optional dependency `@napi-rs/keyring` from `^1.1.6` to `^2.1.0` after reading the 2.x
  changelog for `AsyncEntry` changes.
- The `Store` change is why this package is plan-mode (`CLAUDE.md` lists `client-core`).

**5. macOS keychain.** `KeychainStore.setToken` sets `kSecAttrAccessible` without
`kSecUseDataProtectionKeychain` (`Store.swift:264-284`), so macOS ignores it.

- **Recommend trying the data-protection keychain first.** On `errSecMissingEntitlement` (-34018:
  unsigned CLIs, and probably CI's test bundle), fall back to the file-based keychain and report
  `degraded: legacy-keychain`.
- Read both keychains (data-protection first) so existing items still load, and delete from both on
  clear.
- The alternative is to document the trade-off (notes/E9 §12 item 5); the plan chooses.

**6. `ramBucket`.** Node emits `"0.5"`-style values below 1 GiB (`fingerprint.ts:62-66`), while Python
and Swift omit the component. **Recommend Node omits it too.** Pin the rule in a `ramBuckets`
section: byte counts to a bucket or `omitted`.

**Corpus.**

- The new sections are additive, and the hash formulas and `componentOrder` do not change.
  **Recommend `fingerprintVersion` stays 1**; the plan confirms it.
- Each SDK exposes pure helpers the runners call: `parseWindowsCim(output)`,
  `linuxAnchorSource(readable)`, `ramBucket(bytes)`, with snake_case in Python.
- The Worker's `fingerprintCorpus.test.ts` keeps checking the unchanged formulas.

## Steps

1. The wire planner writes `program/plans/P1b-09.md` covering the six decisions, the corpus sections,
   the `Store` change, SDK order (Node, Python, Swift; React is N/A for fingerprints) and the
   migration notes. It sets `awaiting-approval` and stops.
2. After approval: the generator sections, then corpus and mirror regeneration.
3. Node, then Python, then Swift, one commit per item and SDK, each with runner and unit tests.
4. `PRIVACY.md`, the SDK docs, `reference/corpus.mdx`, the manifests; the green gate.

## Acceptance criteria

- [x] `program/plans/P1b-09.md` is merged (approved) before any code change.
- [x] `fingerprint.json` carries the new sections with the mirrors (Swift, Godot);
      `mise exec node@22 -- pnpm gen:corpus -- --check` passes.
- [x] Node, Python and Swift pass every section that applies to them; the Worker's fingerprint corpus
      test passes.
- [x] No `wmic` invocation remains in `packages/sdk-node/src` or `sdks/python/src`
      (`grep -rn wmic` is empty).
- [x] On Linux, a unit test with `product_uuid` readable and unreadable yields the same
      `machineUuid`.
- [x] Each SDK reports `degraded` in a test where the keyring backend is missing or failing.
- [x] The directory defaults have unit tests per OS, and the config directory is unchanged unless the
      plan decided otherwise.
- [x] `docs/PRIVACY.md` lists the new sources; `pnpm --filter @polaris-key/docs gen:check` passes.
- [x] `parity.json` manifests are updated for every SDK this changes, and `pnpm parity:check`
      passes.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- fingerprint
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Interfaces:**
  - `Store.status()` and `StoreStatus`, with `client.storeStatus()` / `store_status()`;
  - the `dataDir`, `cacheDir` and `stateDir` options and defaults;
  - the pure helpers `parseWindowsCim`, `linuxAnchorSource` and `ramBucket`;
  - the new `fingerprint.json` sections.
- P4-06 and P4-07 put pack stores under the new data directory. P1-05 (Godot) and P6-05 and X-01
  follow the same anchor, `ramBucket` and Windows rules and pass the same sections.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-09 done`.
