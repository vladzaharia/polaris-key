# P1-10 Godot UI kit v1 and `PKeyBoot` shell

| Field       | Value                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                                                                                                                                                   |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                 |
| Depends on  | [P1-03](P1-03-godot-license.md), [P1-04](P1-04-godot-config.md), [P1-07](P1-07-godot-identity.md), [P1-09](P1-09-boot-stage-machine.md), [P1-08](P1-08-godot-update-check.md), [P1-11](P1-11-godot-export-plugin.md) |
| Unblocks    | [P1-12](P1-12-godot-release.md), [P3-10](P3-10-godot-updater.md), [P4-08](P4-08-godot-packs.md)                                                                                                                      |
| Role        | `pkey-godot-engineer`                                                                                                                                                                                                |
| Plan mode   | no (it ports P1-09's approved machine; it adds no corpus rows)                                                                                                                                                       |
| Gates       | `stage-matrix.json` in the Godot runner on both targets; UI structural snapshot tests                                                                                                                                |
| Human input | none (screenshots for review are taken by the agent from an editor run)                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                            |

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

- `core/stages.gd` (`PKeyStages`, not `ui/boot/`, so headless exports can use it): a GDScript port
  of `client-core`'s `bootTransition` and `bootGuardAction`, with the five vocabulary constants, and
  a `stage-matrix` suite in the Godot runner (rows, probes and guard cases, from
  `res://tests/corpus/v2/stage-matrix.json`) plus a malformed-event test. It compares `failedBoots`
  numerically, because Godot parses JSON numbers as floats.
- `boot/pkey_boot.tscn` (`PKeyBoot`): built-in controls only, a logo slot, a status line, a
  progress bar, the offline and error cards (Retry; "Play offline" when the machine allows it).
  Signals `stage_changed(stage, previous)`, `blocked(reason)`, `offline(can_play_offline)`,
  `error(code)`, `boot_ready()` (not `ready()`: a `Control` cannot redeclare `ready`, plan
  decision 10), `waiting(status)`, `update_available()` and `boot_rolled_back()`. It does a stage's
  work each time the machine enters that stage, including `shell` and `guard` again after a retry
  that resumes there. It feeds the machine from real work: `shell` (build stamp if present,
  cache load), `guard` (`ok` until P3-10), `sync` (`PolarisKey.sync()` with a bounded timeout),
  `gate` (`PolarisKey.status()`, then the gate UI until resolved), `decide`
  (`PolarisKey.update.check()`), `fetch` and `mount` (`ok` until P4-08).
- **What `PKeyBoot` sends** is exactly [P1-09 plan §2.2](../plans/P1-09.md) "What a host sends". A
  sync is `ok` when answered (200, 304, 401, 403 or 429), `offline` when a document got no answer
  (status 0), and `error` when an answer was unusable. A failed update check is `decide.done none`,
  a failed download is `fetch.done failed`, and `fail` is only for exceptions. There is no
  `gate.resolved`: send `gate.status` again. `fetch.done` carries `installed`. A fake-server test
  covers each sync class.
- **Keyless registration.** With no token, a product without License whose registration policy is
  `open` (discovery's `core.registration` when present, otherwise the §6 default from
  `expected_services`) calls `PolarisKey.devices.register()` inside `sync`, before
  `PolarisKey.sync()`. A registration with no answer is `sync.done offline`, and one refused or
  unusable is `error`. Fake-server tests cover both, and an offline first launch under
  `allow_offline: false` that stops at `offline`.
- `PolarisKey.boot(opts) -> PKeyBootResult` (`outcome`, `reason`), with `allow_offline`, `allow_grace` and
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
- Diceroll's wiring: the sign-in dialog, settings and gate in
  [D-02](D-02-diceroll-after-p1.md); its `BootShell` visuals on `PKeyBoot` in
  [D-04](D-04-diceroll-after-p4.md).
- Paid unlock UI (→ P6-01).

## Design notes

- **Stage matrix version 2 (P3-01's approved plan, §2.10, §8).** `stage-matrix.json` is version 2
  once P3-02 lands. If this package lands after it, implement `bootConfirmation` and
  `BOOT_OK_SECONDS` in the Godot port, and have the stage runner read `confirmCases`. No v4
  decision sends `decide.done required`.
- **Stage budgets on a low-end phone ([S-04](../../notes/S-04-low-end-performance.md), derived).**
  - Natively, budget about 0.25 s for trust + licence + config (three small verifies), up to
    about 0.9 s for one 350 KB bundle import, and 0.1 s or less for the cache.
  - On the web build without WebCrypto Ed25519, budget about 0.45 s for the three small verifies
    and 1.6 s (blocking) or 6–12 s (sliced) for the bundle.
  - Show progress once a stage passes 250 ms.
    - P1-02 deferred the sliced bundle verify's progress signal to this package: emit the
      `PKeyEd25519Job` phase fraction through a `PolarisKey` signal.
  - Never time a verify stage out in under 10 s natively or 30 s on sliced web: on an A53-class
    phone a 1 s stage is normal, not a hang. A desktop host takes about 11 ms and 37 ms natively
    (19–42 ms and 75–160 ms on web) for the same stages.

- **MOUNT pacing** (S-05 §4.1): the `mount` stage starts after the first frame has been drawn and
  mounts at most one pack per frame, on the main thread (`PackedData` and the UID registry are not
  documented as thread-safe while the main thread loads resources; a `Thread` mount lowered the
  hitch on an Android emulator but did not remove it, so that evidence is inconclusive). Mount cost
  follows entry count, not bytes. A mount freezes the spinner for the whole call, so the budget is
  at most 100 ms (6 frames at 60 Hz) per mount on a low-end phone: packs of up to 1,000 entries may
  mount under the spinner (an estimated 48–80 ms on a phone assumed 3–5× slower than the emulator's
  16 µs per entry cold); packs above 1,000 entries mount only while a loading screen (not just the
  spinner) is shown. A mount in `_ready` held the first frame back by about its own call
  time (the first `_process` came 88–276 ms after `_ready` for a 12,800-entry pack, against a
  31 ms median without one).

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

- [x] The Godot runner passes every `stage-matrix.json` row (stage sequence, emitted events,
      outcome) on the 4.7.2 editor and release template.
- [x] `PKeyBoot` driven by a fake host reproduces each row's stage sequence in its signals, and
      `PolarisKey.boot()` returns the row's outcome.
- [x] Snapshot tests exist for every gate status, every activation-panel capability combination
      (License on/off, Identity on/off, enrolment on/off, web), the sign-in dialog (pending,
      expired, cancelled), and a settings catalog with `enforced`, `default`, `hidden`,
      `dependsOn` and `advanced` entries; they pass.
- [x] A focus-traversal test reaches every interactive control on each scene with `ui_down` and
      `ui_accept` alone.
- [x] An enforced setting shows a disabled control and "Set by <product>"; editing a default
      setting writes the override store and changes `get_source()` to `local`.
- [x] No visible string bypasses `PKeyUiCopy`/`tr()` (a test walks every `Label` and `Button`).
- [ ] Editor screenshots of each scene are attached to the PR. (`tools/ui_screenshots.gd`
      rendered all 67 states from an editor run; there is no PR from this branch yet to attach
      them to.)
- [x] The `stage-matrix` suite drives `PKeyStages` through every row, every probe and every guard
      case of `stage-matrix.json`, and the fake-server tests drive `PKeyBoot` through the sync
      classes above.
- [x] The green gate passes (`AGENTS.md`), including the `godot` CI job (run locally: the
      editor and the 4.7.2 macOS release template, and the new suites on the 4.4.1 floor editor;
      CI's Linux legs run on push).
- [x] `sdks/godot/parity.json` marks `ui.stages` and `ui.kit` implemented, with test tags (once
      P1b-01 has landed).

## Implementation notes (P1-10)

Where the code and this brief differ, the code is right; these are the corrections.

- **The gate's class is `PKeyGateView`.** `PKeyGate` is already the licence-gate logic
  (`core/gate.gd`, `license_state` and `is_usable`), so the scene's script cannot take the name.
  The scene file is `ui/gate/pkey_gate.tscn` and its root node is still named `PKeyGate`.
- **Stage matrix version 2.** P3-02 had landed, so `PKeyStages` also has `boot_confirmation`,
  `BOOT_OK_SECONDS`, `BOOT_CONFIRMATIONS` and `BOOT_DECISIONS`, and the runner reads
  `confirmCases` and `vocabulary.confirmations`. The suite file is `suite_stage_matrix.gd`;
  `--pkey-test stage-matrix` is an alias in the runner's `SETS`.
- **DECIDE uses the signed decision.** P3-08 had landed, so the decide stage calls
  `PolarisKey.update.decide()` and sends `optional` when its boot decision is `optional`; it falls
  back to the v3 `update.check()` only when `decide()` answers `service-unavailable` or
  `not-configured`. No decision sends `required` (plans/P3-01.md decision 1), so an update floor
  never stops play; a mandatory or blocked answer is a persistent banner with no dismiss that
  never covers the game (`PKeyUpdatePrompt`, React's `UpdatePrompt` states).
- **The no-answer status was not kept.** `PKeySyncResult.documents` held only each document's
  kind, so this package adds `PKeySyncResult.errors` (`{status, code}` per failed document, status
  0 for no answer) and `classify()`. A document that fails verification now reports status 200
  (an unusable answer), not 0. Transport refusals of an answer that did arrive
  (`response-too-large`, `too-many-redirects`, `insecure-redirect`) count as unusable.
- **"Continue free" is the game's choice** (`offer_enrollment`, off by default). The Worker
  advertises the enrolment endpoint for every product with License, so discovery cannot say
  whether a free tier exists.
- **The binary action needs a page.** A v4 decision carries no URL, so a binary answer on a direct
  build opens the `release_url` the game gives (the v3 answer's own `url` otherwise); without one
  the prompt shows no action. A store, Steam or itch build never opens a download page.
- **The offline request code is the device id**, which is what the console's offline-bundle
  dialog asks for (32 characters); the product slug is shown beside it, and the QR code holds the
  id.
- **`PolarisKey.boot()` resolves at the first stop.** A stop reached after a Retry on the card
  arrives as `PKeyBoot.boot_finished` and `PolarisKey.boot_finished`.
- **Never covering, measured.** PKeyBoot and PKeyGateView are Containers, which ignore a child's
  anchors, so PKeyBoot hosts the update prompt on a plain full-rect `Overlay` Control with mouse
  ignore, the prompt's banner mode asks a container for its own height only
  (`SIZE_SHRINK_BEGIN`) and trims itself to its minimum height outside one, and the gate's
  `BannerSlot` shrinks to the top in grace (its `Center` ignores the mouse there). `suite_ui`
  checks rendered heights on a 1152x900 screen, not anchors.
- **The prompt outlives a drop-in boot.** `PolarisKey.boot()` without a view frees its PKeyBoot at
  READY, but a visible prompt is handed to the CanvasLayer first (`PolarisKey.boot_prompt`): a
  locked answer stays, a dismissable one is freed on dismiss. `keep_update_prompt: false` opts
  out. `PolarisKey.update.last_available` (new) keeps the last announced answer so a
  `PKeyUpdatePrompt` added later replays it. `suite_boot`'s `dropin` group covers it.
- **Channel lock.** The dev-menu channel picker is locked when the build's outlet does not allow a
  channel switch (`PKeyDecision.effective_capabilities(kind).channelSwitch`, so only a direct
  build or the editor may switch); picking a channel emits `channel_selected` for the game to
  apply at the next configure.
- **Progress.** The sliced verify's progress is `PolarisKey.verify_progress(fraction)`
  (`PKeyEd25519Job.progress()`, reported by `PKeyJws.run_job` in sliced mode).
- **Fixtures.** One snapshot file per scene with a section per state, under
  `tests/ui/snapshots/`, included in the exported pack so the template runs them too.
- **Timings** (M-series Mac, 4.7.2, editor / macOS release template, after the review fixes):
  `stage_matrix` 16 / 15 ms (56 rows, 6,594 probe transitions); `boot` 6.8 / 7.4 s (five
  deliberate 1 s request deadlines, plus the drop-in group); `ui` 13.6 / 11.7 s (67 states, each
  snapshotted, focus-walked and copy-checked, plus the measured never-covering checks). The new
  suites also pass on the 4.4.1 floor editor.
- **Screenshots.** `sdks/godot/tools/ui_screenshots.gd` renders all 67 pinned states with the
  default theme (needs a display). The branch is not pushed here, so attaching them to the PR is
  left to whoever opens it.

## Verify

```sh
godot --headless --path sdks/godot -- --pkey-test ui,boot,stage-matrix,conformance
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.boot()`, `PKeyBoot` and its signals, and the scene names above: P4-08 adds the pack
  work behind `fetch` and `mount` and the theme swap; D-02 uses the sign-in dialog, settings
  panel and gate; D-04 plugs Diceroll's `BootShell` visuals into `PKeyBoot`'s signals.
- `PKeyUiCopy` keys and `pkey_theme.tres`: games override copy and theme without forking scenes.
- `PKeyDeviceList` is unowned; the lead should add it to P1-12 or a follow-up (it needs P1-05).
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-10 done`.
