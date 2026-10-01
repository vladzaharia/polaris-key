# P1-08 Godot update-check parity with the existing SDKs

| Field       | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                              |
| Size        | 0.25–0.5 engineer-weeks                                         |
| Depends on  | [P1-02](P1-02-godot-core.md)                                    |
| Unblocks    | [P1-10](P1-10-godot-ui-kit.md), [P1-12](P1-12-godot-release.md) |
| Role        | `pkey-godot-engineer`                                           |
| Plan mode   | no                                                              |
| Gates       | none beyond the green gate and the `godot` CI job               |
| Human input | none                                                            |
| Repo        | `vladzaharia/polaris-key`                                       |

## Goal

`PolarisKey.update` and `PolarisKey.release` do what the Node and Python clients do today, and no
more: check the newest version on a channel and say whether this build is behind it, emit
`update_available`, derive the appcast URL from discovery, fetch the changelog, and build install
and artifact download URLs. Every call refuses without a request when the product does not run
the service.

## Why

Diceroll adopts update checks at the P1 milestone (report
[§13](../../README.md#13-diceroll-adoption-path)), and the `DECIDE` stage of `PKeyBoot` needs a
check to call. The parity rows are `update.check`, `release.changelog` and `release.download`
([PARITY §5.5](../../PARITY.md#55-release-and-update); notes/A2 §9.6). The outlet-aware update
decision, the signed feed and in-game installation are wire v4 work, not this.

## Read first

- `AGENTS.md` and the [P1-02](P1-02-godot-core.md) hand-off (`PolarisKey.core.request`,
  `PKeySemver`, capabilities).
- [notes/A2](../../notes/A2-sdk-port.md) §2 (the `update` and `release` routes) and §9.6.
- Reference code: `packages/sdk-node/src/update/client.ts:42-92` (`check`, `appcastUrl`);
  `packages/sdk-node/src/release/client.ts` (`changelog`, `installUrl`, `downloadUrl`);
  `packages/sdk-node/src/discovery.ts:295-312` (`appcastUrlFrom`);
  `sdks/swift/Sources/PolarisKeyUpdate/UpdateClient.swift` (the same check in Swift);
  `sdks/python/src/polaris_key/{update,release}/client.py`.
- `packages/worker/openapi/polaris-key.v3.yaml` at `/{product}/update/version`,
  `/{product}/release/changelog` and `/{product}/release/dl/{version}/{asset}`.

## Scope

**In:**

- `services/update.gd` (`PolarisKey.update`): `await check(channel := "")`, returning a
  `PKeyVersionCheck` (`version`, `tag`, `url`, `update_available`); signal
  `update_available(check)`; `appcast_url(channel := "", arch := "") -> String` (empty when
  discovery is not loaded or Update is off).
- `services/release.gd` (`PolarisKey.release`): `await changelog() -> PKeyChangelogResult` (a
  PKeyResult whose `entries` is `Array[PKeyChangelogEntry]`: `version`, `tag`, `date`, `summary`,
  `url`), `install_url()`,
  `download_url(version, binary, arch, checksum := false, dmg := false) -> String` (both ""
  with Release off).
- The bearer token is forwarded when one is held (`entitled` access mode needs it); a 403 maps
  to the body's code (default `forbidden`); any other failure to `not_found`; a disabled service
  to `service-unavailable` before any request.
- An `update` suite against the fake server, in the `ci` set.

**Out** (and where it belongs instead):

- The outlet-aware update decision, the signed feed and release records
  (→ [P3-08](P3-08-v4-godot.md)); outlet adapters, downloading, verifying and installing builds
  (→ [P3-10](P3-10-godot-updater.md)).
- A Swift and React release client (→ [P1b-07](P1b-07-license-config-release-gaps.md)).
- The update banner and prompt (→ [P1-10](P1-10-godot-ui-kit.md)).
- Packs (→ [P4-08](P4-08-godot-packs.md)).

## Design notes

- **Compare with the same semver the gate uses** (`PKeySemver.compare`, a port of
  `client-core/src/semver.ts`), against the host application's version (`PKeyOptions.version`),
  never the SDK's. A check that disagreed with the gate would offer a build the gate then blocks.
- **Channels:** send `?channel=` only when asked; the value must be a Release channel name in
  P0-04's unified vocabulary. `?channel=1.2.3` is rejected by the server even though older docs
  show it (report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #20).
- **Appcast URL:** a channel feed is a path segment (`/update/<channel>/appcast.xml`), `arch` is a
  query parameter; take the base from discovery, never string-build the host (as
  `appcastUrlFrom` does). It exists for parity; Godot has no Sparkle.
- **Download URL:** `release/dl/<version>/<binary>-<arch>`, each segment encoded as JS
  `encodeURIComponent` does (`PKeyUri.component`; `String.uri_encode()` also encodes `!'()*`, so it
  is not byte-identical to Node), `?checksum=sha256` when asked. The server requires an arch suffix
  (`arm64|aarch64|x86_64|amd64`). Only the URL is built here: fetching it needs P1-02's
  credential-safe redirects and `accept_gzip = false`, which is P3-10's job.
- **No throttle in the SDK.** A caller decides when to check (P1-10's `DECIDE` stage checks once
  per boot). If a periodic check is added, a failed check must not consume the interval (a
  Diceroll bug, report §9.2 item 11).
- **Store builds:** in P1 the check is informational for every outlet. A Steam, itch or store
  build must not act on it by itself; P1-10 shows a store link or nothing, and P3 makes the
  decision outlet-aware.

## Steps

1. Write `services/update.gd` and `services/release.gd` over `PolarisKey.core.request`.
2. Port the URL derivations and their tests from Node.
3. Add the fake-server suite.

## Acceptance criteria

- [ ] `check()` against the fake server returns `update_available == true` when the served version
      is newer than `PKeyOptions.version` (including a pre-release ordering case) and `false`
      when equal or older, and emits `update_available` only in the first case.
- [ ] A 403 `{"error":{"code":"channel_not_allowed"}}` returns a result with that code; a 404
      returns `not_found`; with Update disabled in discovery, `check()` returns
      `service-unavailable` and the fake server records no request.
- [ ] `appcast_url("beta", "arm64")` equals Node's `appcastUrlFrom` for the same discovery
      document; it is empty before discovery.
- [ ] `download_url("1.2.3", "diceroll", "x86_64", true)` equals Node's `downloadUrl` output
      byte for byte, including encoding.
- [ ] `changelog()` returns an empty array for a body without `entries`, and forwards the bearer
      token when one is held.
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [ ] `sdks/godot/parity.json` marks `update.check`, `release.changelog` and `release.download`
      implemented, with test tags (once P1b-01 has landed).

## Verify

```sh
godot --headless --path sdks/godot -- --pkey-test update
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.update.check`, the `update_available(check)` signal and `PKeyVersionCheck`: P1-10's
  `DECIDE` stage, banner and prompt consume them; P3-08 replaces the decision behind the same
  signal with the outlet-aware one.
- `PolarisKey.release.download_url`: P3-10 downloads through it.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-08 done`.
