# P1-05 Godot devices: fingerprint per platform, register, manage, report (`engine`/`outlet` keys)

| Field       | Value                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P1: Godot SDK core                                                                                                                                           |
| Size        | 1–1.25 engineer-weeks                                                                                                                                        |
| Depends on  | [P1-02](P1-02-godot-core.md)                                                                                                                                 |
| Unblocks    | [P1-03](P1-03-godot-license.md), [P1-12](P1-12-godot-release.md)                                                                                             |
| Role        | `pkey-godot-engineer`                                                                                                                                        |
| Plan mode   | no (the report is unsigned telemetry; `shared-protocol` is not touched)                                                                                      |
| Gates       | `corpus:fingerprint` (`fingerprint.json` vectors in the Godot runner); worker tests and the OpenAPI `FactsReport` schema for the two new report keys; rule 7 |
| Human input | none                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                    |

## Goal

`PolarisKey.devices` collects the hardware fingerprint per platform (hashed on the device),
derives the device id from the same raw sources as Node and Swift on desktop, registers
keylessly, lists, renames and deauthorises the current device, and reports device facts after
every sync. The Worker accepts two new report keys, `engine` and `outlet`, bounded and
allowlisted. The Godot runner passes every `fingerprint.json` vector.

## Why

Licence tiers, free-tier enrolment and seat de-duplication all key on the fingerprint and the
device id (notes/A2 §3.1). Godot's `OS.get_unique_id()` is **not** the same raw value Node and
Swift hash on Windows (a hardware-profile GUID, not `MachineGuid`) or macOS (the serial number,
not `IOPlatformUUID`), and Godot has no API for MACs, board serials or volume ids (report
[§5.3](../../README.md#53-transport-persistence-device-identity), notes/A5 §5). The report
allowlist silently drops anything it does not know, so engine and outlet facts that operators
need for triage and, later, rollouts cannot be sent today (report
[§3.6](../../README.md#36-update-what-an-installed-app-should-do-next), notes/A2 §8). Feature
ids: `devices.fingerprint`, `devices.facts`, `devices.register`, `devices.manage`,
`devices.report` ([PARITY §5.4](../../PARITY.md#54-devices-and-identity)).

## Read first

- `AGENTS.md` rule 7 and `docs/PRIVACY.md` (what may be collected, and the tables to extend).
- [notes/A2](../../notes/A2-sdk-port.md) §3 (server expectations, per-SDK sources, the Godot
  table in §3.3, policy × mode in §3.4), §8 (facts and the allowlist), §9.4.
- [notes/A5](../../notes/A5-godot-empirical.md) §5 (what each `OS` call returns per platform).
- Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #17 (header
  values), #23 (`wmic` is gone from Windows 11), #24 (Linux anchor depends on privilege).
- Reference code: `packages/sdk-node/src/devices/{fingerprint.ts,deviceId.ts,facts.ts,client.ts}`
  (raw readers and normalisation, e.g. `primaryMac` at `fingerprint.ts:81-92`);
  `packages/sdk-node/src/core/telemetry.ts:29-74` (what is reported, and when);
  `sdks/swift/Sources/PolarisKeyCore/{Fingerprint.swift,DeviceID.swift}`.
- Server: `packages/worker/src/fingerprint.ts` (hashing, parsing, matching);
  `packages/worker/src/core/devices.ts:859-1010` (`REPORT_KEYS`, `boundedReport`,
  `factsFromReport`, `handleReport`); `packages/worker/openapi/polaris-key.v3.yaml` (the
  `/devices/report` description and `FactsReport` at `:3164`);
  `packages/docs/src/content/docs/services/core/device-principal.md:250-280`.
- The P1b-09 plan, if it exists, for any change to the Linux anchor or Windows readers.

## Scope

**In:**

- `core/fingerprint.gd` (`PKeyFingerprint`): `collect(slug)`, `raw_components()`,
  `hash_components(slug, raw)`; component hash
  `base64url(sha256("pkey-hw:<slug>:<component>:<raw>"))[0:22]`, composite `hwid` over the
  canonical order; omission of anything unreadable.
- Raw readers per platform (notes/A2 §3.3), each a pure parser over captured command output:
  - Windows: `reg query …\Cryptography /v MachineGuid`; one PowerShell call
    (`-NoProfile -NonInteractive`, `Get-CimInstance`) printing `Win32_BaseBoard.SerialNumber` and
    `Win32_ComputerSystem.Model` as JSON, as P1b-09 recommends for Node and Python (no `wmic`);
    `getmac /fo csv /nh`; `cmd /c vol C:`;
  - macOS: `ioreg -rd1 -c IOPlatformExpertDevice` (UUID and serial); `diskutil info -plist /`;
    `ifconfig`; `OS.get_model_name()`;
  - Linux: `/etc/machine-id` then `/var/lib/dbus/machine-id`, never `product_uuid`, and no
    `board_serial` (P1b-09's recommendation; see Design notes); `/sys/class/net/*/address`;
    `findmnt -no UUID /`; `/sys/class/dmi/id/product_name`;
  - all native: `cpuModel` = `OS.get_processor_name() + ":" + str(OS.get_processor_count())`
    (empty on Android: omit); `ramBucket` from `OS.get_memory_info()["physical"]`;
  - iOS/Android: anchor `OS.get_unique_id()`, model, RAM (and CPU on iOS); web: nothing.
- **Desktop device-id raw source** replacing P1-02's default through
  `PKeyDeviceId.set_raw_source`: `MachineGuid` on Windows, `IOPlatformUUID` on macOS.
- `core/facts.gd` (`PKeyFacts.collect(probes)`): `os`, `hardware`, `runtime`
  (`{name: "godot", version: Engine.get_version_info().string}`), `locale`, IANA `timezone` where
  available (web via `JavaScriptBridge`; omit elsewhere unless IANA is readable), and desktop
  probes for product-declared paths only.
- `services/devices.gd` (`PolarisKey.devices`): `await register()` (keyless, optional
  fingerprint, token source `register`), `get_current_device()`, `await list()`,
  `await rename(label)`, `await deauthorize()`, `await report()`; automatic report after each
  sync through P1-02's post-sync hook.
- **Report payload:** facts plus `sdk`, `sdkVersion`, `appVersion`, `platform`, `arch`, `gate`,
  `config` and `entitlements` (values only, from re-verified documents), and the new `engine`
  and `outlet`.
- **Worker:** add `engine` and `outlet` to `REPORT_KEYS` with bounds (`engine`: an object of
  known fields, strings truncated to 128, unknown fields dropped; `outlet`: a string truncated to
  64); update the `FactsReport` schema, its "fifteen top-level keys" wording and an example; a
  worker test; `device-principal.md`'s allowlist; `docs/PRIVACY.md` (Godot in the fingerprint
  heading, the two new facts).
- A `devices` suite (parsers over committed fixture outputs, facts shape, register/manage/report
  against the fake server) and `fingerprint.json` in `suite_conformance.gd`. Editor smoke legs on
  `windows-latest` and `macos-14` in the `godot` CI job that run the `platform` suite and assert
  the anchor is present.

**Out** (and where it belongs instead):

- Cross-SDK fixes for `wmic`, the Linux anchor and `ramBucket` below 1 GiB, and any new
  `fingerprint.json` cases (→ [P1b-09](P1b-09-fingerprint-storage-fixes.md), plan mode); Godot
  follows its outcome.
- Canonical header and platform values (→ [P1b-04](P1b-04-headers-config-corpora.md)).
- Runtime outlet detection (→ [P3-11](P3-11-outlet-detection.md)); here `outlet` comes only from
  the build stamp (P1-11), else it is omitted.
- Update and pack telemetry events (`update_applied`, `boot_rolled_back`, …) (→ P3-10, P6-03).
- Console display of the new keys and product-wide device lists (→ P0-06 and later console work).
- The device list scene (→ [P1-10](P1-10-godot-ui-kit.md) or later; see its brief).

## Design notes

- **Rule 7.** Raw values never leave the device: only the 22-character component hashes and the
  32-character device id do, and the server recomputes `hwid` and ignores the client's.
  Collection is desktop-heavy by nature; never read anything not in the seven components.
- **Stability matters within an SDK, not across SDKs.** Hashes are salted per product and binding
  is per device id, so Godot need not match Node byte for byte on every component (notes/A2 §3.2).
  It **must** match on the device-id raw source on desktop, which is why `MachineGuid` and
  `IOPlatformUUID` replace `OS.get_unique_id()` there. Normalise MACs to lowercase,
  colon-separated, lowest first, as Node does (`getmac` prints uppercase with dashes).
- **`OS.execute` blocks and is desktop only.** Collect once, on a `WorkerThreadPool` task at first
  launch, and memoise for the session. PowerShell start-up is slow; never on the main thread.
  A Mac App Store sandbox may block `ioreg`; then omit the component and use `get_unique_id()`
  for the device id, and document it.
- **Linux anchor:** `product_uuid` and `board_serial` are root-only, so the fingerprint would
  change with privilege. P1b-09 recommends `machine-id` only, never `product_uuid`, and no
  `board_serial` on Linux; use that rule from the start (a game never runs as root anyway), and
  follow P1b-09's approved plan if it differs.
- **`ramBucket` below 1 GiB:** omit it (Python and Swift do; Node emits `"0.5"`).
- **Web:** no fingerprint (`devices.fingerprint` is an allowed `runtime` N/A); report the facts
  Godot has. **Strict tiers** are unusable on web, and device-code sign-in never sends a
  fingerprint (notes/A2 §3.4); say so in the README (P1-12).
- **Report proposal** (names are new here; P1b-02 generates them later):
  `engine = {id, version, renderer, videoAdapter, videoVendor, videoApi, display, debug}`, where
  `id` is the requirements form `godot-<major>.<minor>` (report §3.1; P1b-04 pins that format if
  it runs after this) and the rest come from `Engine.get_version_info()`,
  `ProjectSettings "rendering/renderer/rendering_method"`, `RenderingServer` adapter calls,
  `DisplayServer.get_name()` and `OS.is_debug_build()`; `outlet` is an outlet id from report
  [§3.1](../../README.md#31-vocabulary) (`direct`, `steam`, `itch`, `app-store`, …). The Worker
  bounds the shape but does not validate outlet ids, because P2b adds outlets.
- **No migration and no `shared-protocol` change.** The report is persisted whole in
  `devices.reported_json`; the typed `device_facts` columns are unchanged. Deploy order does not
  matter: a Worker without the change drops the two keys silently. Adding the fields to
  `DeviceFacts` in `shared-protocol` would make this a plan-mode change; leave the type alone.
- **Manage is self-only.** A device token may rename or deauthorise only its own device; other
  rows are read-only (server R3-09). `deauthorize()` then wipes locally like `license.deactivate`.
- Registration is rate limited to 10 per minute per IP and refused with one body for four causes
  (`registration_closed`); do not retry in a loop.

## Steps

1. Capture command outputs on real machines (or from the research notes) as fixtures; write the
   parsers test-first.
2. Write `PKeyFingerprint` and add `fingerprint.json` to the runner.
3. Plug in the desktop device-id sources; run the `platform` suite on Windows, macOS and Linux.
4. Write `PKeyFacts` and `services/devices.gd`; hook the report into sync.
5. Change the Worker allowlist, OpenAPI schema, test, docs page and `PRIVACY.md`.

## Acceptance criteria

- [ ] The runner reports every `fingerprint.json` component vector (including `unicode-model`
      and `reversed-input-order`) and every `deviceIds` vector passing on both targets.
- [ ] Parser tests over committed fixtures cover every Windows, macOS and Linux reader, including
      `getmac` normalisation and a missing command (component omitted, no error).
- [ ] The `platform` suite on the Windows and macOS CI legs finds the anchor, and the derived
      device id equals `PKeyDeviceId.from_raw(slug, MachineGuid)` / `(slug, IOPlatformUUID)`.
- [ ] Fake-server tests: `register()` stores the token with source `register`; `rename` and
      `deauthorize` target only the current device; a report is sent after each sync with the
      allowlisted keys only, and is skipped after a hard 401.
- [ ] `mise exec node@22 -- pnpm --filter @polaris-key/worker test` includes a test that
      `engine` and `outlet` survive `boundedReport`, that unknown `engine` fields are dropped and
      long strings truncated; `routeCoverage` and the OpenAPI schema stay green.
- [ ] No raw component value appears in any request body (a test asserts it on the fake server).
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job and `pnpm format`.
- [ ] `sdks/godot/parity.json` marks `devices.fingerprint` (with an `except` entry for `web`,
      reason `runtime`), `devices.facts`, `devices.register`, `devices.manage` and
      `devices.report` implemented, with test tags. Marking `devices.facts` implemented ships a
      probe-level test tagged `@pkey-feature devices.facts` (the wave-1 line P1-01 handed on).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- licensingEdge routeCoverage
mise exec node@22 -- pnpm typecheck
godot --headless --path sdks/godot -- --pkey-test devices,conformance
godot --headless --path sdks/godot -- --pkey-test platform
```

## Hand-off

- `PKeyFingerprint.collect(slug)` for P1-03's activation and enrolment; `PolarisKey.devices` for
  P1-10 (device list, if it lands there) and D-02.
- The report keys `engine` and `outlet` and their bounds: P3-10 and P6-03 add update events on
  the same path; the console may display them later.
- Record in the PR which components each platform leg produced.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-05 done`.
