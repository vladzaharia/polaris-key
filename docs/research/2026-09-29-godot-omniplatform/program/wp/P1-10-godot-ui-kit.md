# P1-10 Godot UI kit v1 and `PKeyBoot` shell

| Field       | Value                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P1: Godot SDK core                                                                                                                                     |
| Size        | 1.5–2 engineer-weeks                                                                                                                                   |
| Depends on  | [P1-03](P1-03-godot-license.md), [P1-04](P1-04-godot-config.md), [P1-07](P1-07-godot-identity.md), [P1-09](P1-09-boot-stage-machine.md)               |
| Unblocks    | [P1-12](P1-12-godot-release.md), [P4-08](P4-08-godot-packs.md)                                                                                         |
| Role        | `pkey-godot-engineer`                                                                                                                                  |
| Plan mode   | no (it ports P1-09's approved machine; it adds no corpus rows)                                                                                        |
| Gates       | `stage-matrix.json` in the Godot runner on both targets; UI structural snapshot tests                                                                 |
| Human input | none (screenshots for review are taken by the agent from an editor run)                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                              |

## Goal

A game adds one drop-in boot scene and gets a complete, themable start-up: `PKeyBoot` walks the
P1-09 stage machine (shell, guard, sync, gate, decide, fetch, mount, ready), shows activation,
sign-in or "update required" when needed, and never cuts to another scene. The UI kit v1 scenes
(gate, activation panel, sign-in dialog with QR code, offline activation, settings panel, status
banner, update prompt, entitlement badge, dev-menu section) work with a gamepad, take a `Theme`,
and route all copy through `tr()`. `await PolarisKey.boot({...})` returns one of `READY`,
`BLOCKED`, `OFFLINE` or `ERROR`.

## Why

This is the player-facing half of P1 and what lets Diceroll delete its own gate and settings
plumbing (report [§5.8](../../README.md#58-ui-kit-and-pkeyboot),
[§6.3](../../README.md#63-player-end-user), [§13](../../README.md#13-diceroll-adoption-path)).
`PKeyBoot` generalises Diceroll's `BootShell` (notes/A4 §2.7) and is the first renderer of the
shared stage machine, so it must match `stage-matrix.json` exactly
([PARITY §5.7](../../PARITY.md#57-ui-and-commerce): `ui.stages`, `ui.kit`). React and Swift
already have partial kits to mirror (notes/A2 §10).

## Read first

- `AGENTS.md`; the hand-offs of [P1-03](P1-03-godot-license.md), [P1-04](P1-04-godot-config.md),
  [P1-07](P1-07-godot-identity.md), [P1-08](P1-08-godot-update-check.md) and the approved
  `program/plans/P1-09.md`.
- Report [§5.1](../../README.md#51-shape-and-api) (the `boot()` example),
  [§5.8](../../README.md#58-ui-kit-and-pkeyboot), [§6.3](../../README.md#63-player-end-user).
- [notes/A2](../../notes/A2-sdk-port.md) §10 (every scene, what drives it, its behaviour) and §11
  (settings precedence in the UI).
- [notes/A4](../../notes/A4-diceroll-mapping.md) §2.7 (BootShell states) and §4 (what stays
  game-side).
- [notes/E9](../../notes/E9-runtime-building-blocks.md) §8 (boot and sign-in experience).
- Reference UI: `packages/sdk-react/src/react/hooks.ts:306-335` (`screenFor`),
  `packages/sdk-react/src/components/{LicenseGate,PolarisLogin,ConfigPanel,UpdatePrompt}.tsx`;
  `sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift:25-314` (human copy for every
  activation result).
- `packages/client-core/src/stages.ts` and `conformance/corpus/v2/stage-matrix.json` (from P1-09).

## Scope

**In** (under `addons/polaris_key/ui/` unless noted):

- `boot/stages.gd`: a GDScript port of `client-core`'s `bootTransition`, and a `stage-matrix.json`
  section in the Godot runner (from `res://tests/corpus/v2/`).
- `boot/pkey_boot.tscn` (`PKeyBoot`): built-in controls only, a logo slot, a status line, a
  progress bar, the offline and error cards (Retry; "Play offline" when the machine allows it).
  Signals `stage_changed(stage, previous)`, `blocked(reason)`, `offline(can_play_offline)`,
  `error(code)`, `ready()`. It feeds the machine from real work: `shell` (build stamp if present,
  cache load), `guard` (`ok` until P3-10), `sync` (`PolarisKey.sync()` with a bounded timeout),
  `gate` (`PolarisKey.status()`, then the gate UI until resolved), `decide`
  (`PolarisKey.update.check()`), `fetch` and `mount` (`ok` until P4-08).
- `PolarisKey.boot(opts) -> PKeyBootResult` (`outcome`, `reason`), with `allow_offline` and
  `required_packs` (accepted, empty until P4-08), and the constants `PKeyBoot.READY`, `BLOCKED`,
  `OFFLINE`, `ERROR`.
- Scenes, each with a headless controller script: `PKeyGate` (mirrors `screenFor`),
  `PKeyActivationPanel`, `PKeySignInDialog` (over P1-07's prompt and `PKeyQrRect`),
  `PKeyOfflineDialog` (request code with copy and QR; bundle by file, paste or drag-drop),
  `PKeySettingsPanel`, `PKeyStatusBanner`, `PKeyUpdatePrompt`, `PKeyEntitlementBadge`, and
  `PKeyDevMenuSection` (channel picker with the outlet lock reason, build info, COPY
  DIAGNOSTICS, force check).
- `theme/pkey_theme.tres`; `PKeyUiCopy` (a Resource of English defaults, every string passed
  through `tr()`); focus neighbours on every interactive control.
- UI tests: structural snapshots (visible nodes, texts, disabled flags, focus order) per scene and
  state against committed text fixtures under `tests/ui/snapshots/`, and `PKeyBoot` driven through
  every `stage-matrix.json` row with a fake host. Both join the `ci` set.

**Out** (and where it belongs instead):

- Pack stages: size disclosure, cellular choice, pause, ordered mounts, the theme and font swap
  when the UI pack mounts, background downloads (→ [P4-08](P4-08-godot-packs.md)).
- Boot guard, staged code and restarts (→ [P3-10](P3-10-godot-updater.md)).
- Outlet-aware update actions such as in-app store sheets (→ P3-10, P5-05, P5-06).
- `PKeyDeviceList` (not in the v1 kit; needs P1-05; not owned yet, see Hand-off).
- React `<PolarisBoot>` and SwiftUI `PolarisBootView` (unowned; P1-09 hand-off).
- Diceroll's visuals and its wiring (→ [D-02](D-02-diceroll-after-p1.md)).
- Paid unlock UI (→ P6-01).

## Design notes

- **One machine, many views.** `PKeyBoot` never decides a transition itself; it performs a stage's
  work, sends the result to the machine and renders what the machine says. A game that wants its
  own visuals connects to the signals and hides the default view.
- **Never cut scenes.** The shell stays on screen and "upgrades itself" in place; `READY` hands
  over by signal, and the game changes scene when it wants to.
- **Gate screens** follow `screenFor`: `ok` and `not-applicable` hide the gate and emit `usable`;
  `grace` shows `PKeyStatusBanner` (or blocks when `allow_grace` is false);
  `needs-activation` shows the activation panel; `revoked` says the device was signed out and
  offers sign-in; `expired` asks to connect and retries `sync(true)`; `version-too-old` shows
  "update required" with the outlet's action; `version-too-new` and `channel-not-entitled` say the
  build is not available on this licence.
- **Activation panel:** key entry only when License is enabled; "Sign in" only when
  `PolarisKey.identity.is_available()`; "Continue free" only when enrolment is offered, and never
  on web; "Offline activation…" opens `PKeyOfflineDialog`. Map every `PKeyActivationResult.kind`
  to human copy (Swift's copy is the model).
- **Settings panel** (notes/A2 §10–§11): one row per non-hidden entry, grouped by `category`,
  sorted by `ui.order`; `switch` → `CheckButton`, `stepper` → `SpinBox`, `select` →
  `OptionButton` with `optionLabels`, `textarea`, `password` masked; enforced rows disabled with a
  lock and "Set by <product>"; default rows write to the override store with "Reset to default";
  a provenance badge (`local`, `env`, `remote default`, `fallback`); `dependsOn` hides rows;
  `advanced` sits behind a toggle; `hidden` is never shown.
- **Update prompt** in P1 acts per build: a direct build opens the release URL; a store, Steam or
  itch build shows the store link or nothing. It never downloads.
- **Dev-menu section:** the report says Diceroll registers sections with
  `DevMenu.register_section`; notes/A4 §4.1 says `DevMenu.register_row`. Provide a `Control` plus
  a `rows()` data API so either works, and let D-02 confirm against Diceroll's code. COPY
  DIAGNOSTICS copies device id, outlet, channel, build, SDK and engine versions, gate status and
  last sync time; never tokens or secrets.
- **Headless tests have no renderer**, so snapshots are structural text, not pixels. Attach
  editor screenshots of each scene to the PR for review.
- **Declared dependencies are incomplete:** `DECIDE` and the update prompt need P1-08, and the
  dev-menu section reads the build stamp from P1-11. Confirm both are done before starting; if
  P1-11 is not, fall back to editor defaults (`outlet` absent, channel from `PKeyOptions`).
- Gamepad and TV use: every screen must be operable with `ui_up/down/left/right`, `ui_accept`
  and `ui_cancel`, with a visible focus style in the theme.

## Steps

1. Port `bootTransition`; add the `stage-matrix.json` section to the runner.
2. Build `PKeyBoot` and `PolarisKey.boot()` against a fake host; drive every matrix row.
3. Build the gate, activation, sign-in and offline scenes; wire them into the `gate` stage.
4. Build the settings panel from P1-04's catalog and override store.
5. Build the banner, update prompt, entitlement badge and dev-menu section.
6. Write the snapshot fixtures; take screenshots for the PR.

## Acceptance criteria

- [ ] The Godot runner passes every `stage-matrix.json` row (stage sequence, emitted events,
      outcome) on the 4.7.2 editor and release template.
- [ ] `PKeyBoot` driven by a fake host reproduces each row's stage sequence in its signals, and
      `PolarisKey.boot()` returns the row's outcome.
- [ ] Snapshot tests exist for every gate status, every activation-panel capability combination
      (License on/off, Identity on/off, enrolment on/off, web), the sign-in dialog (pending,
      expired, cancelled), and a settings catalog with `enforced`, `default`, `hidden`,
      `dependsOn` and `advanced` entries; they pass.
- [ ] A focus-traversal test reaches every interactive control on each scene with `ui_down` and
      `ui_accept` alone.
- [ ] An enforced setting shows a disabled control and "Set by <product>"; editing a default
      setting writes the override store and changes `get_source()` to `local`.
- [ ] No visible string bypasses `PKeyUiCopy`/`tr()` (a test walks every `Label` and `Button`).
- [ ] Editor screenshots of each scene are attached to the PR.
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [ ] `sdks/godot/parity.json` marks `ui.stages` and `ui.kit` implemented, with test tags (once
      P1b-01 has landed).

## Verify

```sh
godot --headless --path sdks/godot -- --pkey-test ui,boot,conformance
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.boot()`, `PKeyBoot` and its signals, and the scene names above: P4-08 adds the pack
  work behind `fetch` and `mount` and the theme swap; D-02 plugs Diceroll's visuals into the
  signals.
- `PKeyUiCopy` keys and `pkey_theme.tres`: games override copy and theme without forking scenes.
- `PKeyDeviceList` is unowned; the lead should add it to P1-12 or a follow-up (it needs P1-05).
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-10 done`.
