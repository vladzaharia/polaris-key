# P3-11 Outlet detection in every SDK against `outlet-matrix.json`

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                    |
| Size        | 1–1.5 engineer-weeks                                                                          |
| Depends on  | [P3-02](P3-02-wire-v4-contract-corpus.md)                                                     |
| Unblocks    | none in the graph (see Hand-off: [P3-10](P3-10-godot-updater.md) consumes the Godot detector) |
| Role        | `pkey-sdk-porter` (see `.claude/agents/`)                                                     |
| Plan mode   | no: the matrix and its vocabulary are fixed by `plans/P3-01.md`                               |
| Gates       | corpus (`outlet-matrix.json`); all SDKs                                                       |
| Human input | none. Device checks of the platform APIs belong to S-06 and P5                                |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

Every SDK answers "where did this install come from?" the same way. A pure function (proposed
`detectOutlet`, `detect_outlet` in Python and GDScript) maps observed signals and the build stamp
to `{outlet, confidence, source}`, and it passes every row of `outlet-matrix.json` in Node (via
`client-core`), React, Python, Swift and Godot. Each SDK also reads the signals its runtime can
see without native code, and its update decision defaults to the detected outlet when the host
does not name one.

## Why

The update decision depends on the outlet, and outlet detection is the least portable feature:
only iOS and Android have a first-party API, and Android's install source is declared by the
installer rather than proven. The signals differ per runtime, but the mapping from signals to an
outlet must not, which is why it has its own corpus file
([PARITY §7](../../PARITY.md#7-runtime-limits-that-become-typed-nas),
[§4.1](../../PARITY.md#41-corpora-behaviour-as-data)). Diceroll stamps the outlet per export, not
per artifact, and so mislabels Steam, itch and sideload builds
([README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet),
[§9.2](../../README.md#92-diceroll-for-the-diceroll-side) #2–#3).

## Read first

- `AGENTS.md`; `.claude/agents/pkey-sdk-porter.md`; `plans/P3-01.md` (the row schema, signal
  names, confidence levels, precedence and the capability defaults).
- [notes/E9 §1](../../notes/E9-runtime-building-blocks.md#1-outlet-detection): the signal
  catalogue (§1.1, with verification tags) and what is pure per runtime (§1.2).
- [README §5.5](../../README.md#55-distribution-layer-one-build-any-outlet) (runtime detection
  overrides the stamp when the platform knows better);
  [PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) and
  [§8](../../PARITY.md#8-parity-gaps-to-close-now) (the `AppDistributor` iOS 17.4 guard, P3).
- The decision wiring each SDK got in [P3-04](P3-04-v4-node.md) to [P3-08](P3-08-v4-godot.md);
  `conformance/runners/node`, `sdks/python/tests/`, `sdks/swift/Tests/PolarisKeyTests/`, the Godot
  runner.

## Scope

**In:**

- **The pure function** in `client-core` (with a subpath export), Python, Swift and GDScript, and
  the React SDK's use of `client-core`. No I/O inside it: it takes a signals map and the stamp.
- **Runners**: every `outlet-matrix.json` row in the Node runner, pytest, `swift test` and the
  Godot runner (editor and release template), with the same row names.
- **Signal readers**, pure language or small dependency only (notes/E9 §1.2):
  - Node: environment variables, executable path conventions, `node:sea` `isSea()`, and Electron's
    `process.mas` and `process.windowsStore` when present.
  - React / web: `matchMedia('(display-mode: standalone)')`, `navigator.standalone`, the
    `android-app://` referrer.
  - Python: environment, PEP 376 `INSTALLER`, `sys.executable` (not `sys._MEIPASS`) path
    conventions, `ctypes` `GetCurrentPackageFullName` on Windows.
  - Swift: `AppDistributor.current` behind `#available(iOS 17.4, *)` (the package floor is iOS 17);
    `AppTransaction` on macOS; code-signature and Caskroom checks.
  - Godot: `FLATPAK_ID`, `SNAP`, `APPIMAGE`, `SteamAppId`, feature tags and the build stamp
    `res://.polaris_key/build.json`; iOS and Android signals come from plugin hooks that return
    "unavailable" until [P5-05](P5-05-apple-plugin-package.md) and [P5-06](P5-06-kotlin-aar.md).
- **Wiring**: the update client uses the detected outlet when the host passes none; a host
  override always wins. The result is available to the host (for UI and support diagnostics).
- Docs for each SDK page; `parity.json` in every SDK: `outlet.detect` → `implemented`.

**Out** (and where it belongs instead):

- Verifying the unverified signals on real devices (→ [S-06](S-06-outlet-signals.md)).
- Native signal sources: the Apple plugin package (→ [P5-05](P5-05-apple-plugin-package.md)) and
  the Kotlin AAR's install-source API (→ [P5-06](P5-06-kotlin-aar.md)).
- Acting on the outlet in Godot (→ [P3-10](P3-10-godot-updater.md)).
- Changing `outlet-matrix.json`: that is plan-mode; report a missing row instead.

## Design notes

- **Mapping is shared, reading is not.** Only the pure function is conformance-tested; readers
  are unit-tested with faked environments, because each runtime sees different signals.
- **Precedence** as the plan fixes it: first-party platform evidence (for example
  `AppDistributor`, MSIX `SignatureKind`) over installer-declared evidence (Android) over
  environment and path heuristics over the build stamp; `unknown` when nothing applies, with the
  restrictive capabilities the plan assigns.
- **Detection never widens capabilities.** It chooses an outlet; the outlet's compiled defaults and
  the feed's narrowing decide what the install may do.
- **Unverified signals** (tagged `[I]` or `[M]` in notes/E9 §1.1, for example Steam's environment
  variables and the ACF file) stay marked as such until S-06 reports; do not raise their
  confidence here.
- **Privacy** (AGENTS rule 7): read markers, never enumerate installed applications. Report only
  the detected outlet id, if the telemetry allowlist has an `outlet` key (P1-05).
- **No typed N/A.** Every runtime can at least return the stamp or `unknown`.

## Steps

1. Confirm P3-02 is `done`; branch `wp/P3-11-outlet-detection`. The Godot part needs P1-02, and
   the wiring step needs each SDK's wave package (P3-04 to P3-08). Where one has not landed, ship
   the pure function and readers for that SDK, and leave the default-outlet wiring to its wave
   package with a note in the PR.
2. The pure function and runner sections, one SDK per commit.
3. Signal readers with fake-environment tests, one SDK per commit.
4. Wire the default outlet into each update client; docs; `parity.json`. Set `in-review`.

## Acceptance criteria

- [ ] Node (through `client-core`), Python, Swift and Godot pass every `outlet-matrix.json` row,
      with identical row names; React uses the `client-core` function.
- [ ] Each SDK's readers have unit tests with faked signals for every outlet its runtime can see.
- [ ] Swift's `AppDistributor` call is guarded for iOS 17.4 and the package still builds for its
      iOS 17 floor.
- [ ] Each update client uses the detected outlet when the host passes none, and the host's value
      when it does (a test per SDK).
- [ ] The green gate passes (`AGENTS.md`), including the Python, Swift and Godot jobs.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/react test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

Run the Godot runner with P1-01's command on the editor and on a release template.

## Hand-off

- `detectOutlet` and the per-SDK readers. [P3-10](P3-10-godot-updater.md)'s outlet adapters
  consume the Godot detector (a dependency the graph does not yet show); P5-05 and P5-06 plug
  their native signals into the hooks named here.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-11 done` in the PR
  that completes the work.
