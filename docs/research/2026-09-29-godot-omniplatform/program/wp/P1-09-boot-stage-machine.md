# P1-09 Specify the boot stage machine as `stage-matrix.json` and implement it in `client-core`

| Field       | Value                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                                                                                                        |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                      |
| Unblocks    | [P1-10](P1-10-godot-ui-kit.md)                                                                                                                                            |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                      |
| Plan mode   | yes: `program/plans/P1-09.md` must be approved (merged) before any code                                                                                                   |
| Gates       | plan mode; `corpus:stage-matrix` (a new generated corpus file, its mirrors and `pnpm gen:corpus -- --check`, rule 1); all SDKs; generated `reference/corpus.mdx` (rule 3) |
| Human input | plan approval, including the open decisions below                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                 |

## Goal

The boot protocol (shell → guard → sync → gate → decide → fetch → mount → ready, plus
background, blocked, offline and error) exists once as a pure, headless state machine in
`@polaris-key/client-core`, pinned by a generated corpus file `stage-matrix.json` that the Node,
Python and Swift runners pass. Every renderer (Godot `PKeyBoot`, SwiftUI, React, a terminal) then
draws the same stages, emits the same events and reaches the same outcomes for the same inputs.

## Why

Report [§8](../../README.md#8-carrying-the-concepts-to-the-other-sdks-and-products) item 6 makes
the boot protocol a cross-SDK concept "rendered natively per framework", and PARITY lists
`stage-matrix.json` as the proof for `ui.stages`, and later `update.bootguard` and `packs.state`
([PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data),
[§5.7](../../PARITY.md#57-ui-and-commerce)). notes/E9 §8 and §11 item 2 put the machine in
`client-core` so each toolkit writes only a thin renderer. If Godot writes its own first, the
other SDKs inherit a Godot-shaped machine without a corpus, which is exactly the drift the parity
design exists to stop. The stage table is in report [§5.8](../../README.md#58-ui-kit-and-pkeyboot);
Diceroll's `BootShell` states (notes/A4 §2.7) are the design it generalises.

## Read first

- `AGENTS.md` (rules 1, 3; the wave order), `CLAUDE.md` (plan mode), `program/plans/README.md`.
- Report [§5.8](../../README.md#58-ui-kit-and-pkeyboot) (the stage table),
  [§6.3](../../README.md#63-player-end-user), §8 item 6.
- [PARITY](../../PARITY.md) §2.2 (typed N/As), §4.1, §4.3, §5.5 (`update.bootguard`), §5.7.
- [notes/E9](../../notes/E9-runtime-building-blocks.md) §8 and §11;
  [notes/A4](../../notes/A4-diceroll-mapping.md) §2.7 (`BootShell` states and exits).
- `tools/sign-corpus.ts` (`buildGateMatrixV2`, `reconcile`, the mirror constants) and
  `conformance/runners/node/corpusV2.test.ts` (how a matrix is consumed).
- `packages/client-core/src/{index.ts,gate.ts}` and `package.json` (subpath exports).
- `sdks/python/tests/test_gate_matrix.py`, `sdks/swift/Tests/PolarisKeyTests/GateMatrixTests.swift`
  (how the other runners load a matrix), `sdks/swift/Package.swift:107` (the Swift mirror).
- `packages/docs/scripts/gen-reference.mjs` (the corpus page lists every family).

## Scope

**In:**

- **The plan** `program/plans/P1-09.md`: stages, events and payloads, transitions, outcomes, the
  file format, the rows, the SDK order below, and the decisions for the human.
- **Corpus:** `buildStageMatrixV1()` in `tools/sign-corpus.ts` writing
  `conformance/corpus/v2/stage-matrix.json` (`stageMatrixVersion: 1`, unsigned, like
  `gate-matrix.json`), mirrored into the Swift and Godot mirrors, guarded by `--check`.
- **`client-core`:** `src/stages.ts` (`BootStage`, `BootEvent`, `BootState`,
  `initialBootState(opts)`, `bootTransition(state, event) -> {state, emits}`), exported from the
  barrel and as `@polaris-key/client-core/stages`; unit tests.
- **Runners:** a `stage-matrix` section in the Node runner; a pure port and a runner in Python
  (`polaris_key/core/stages.py`, `tests/test_stage_matrix.py`) and in Swift
  (`PolarisKeyCore/Stages.swift`, `StageMatrixTests.swift` over `Resources/v2/`).
- Docs: the corpus pages (`build/wire/corpus.md`, `contribute/corpus.md`), `gen-reference.mjs`
  for the new family, then `pnpm --filter @polaris-key/docs gen`.

**Out** (and where it belongs instead):

- The Godot port and `PKeyBoot` (→ [P1-10](P1-10-godot-ui-kit.md), which adds the Godot runner
  section).
- Renderers: React `<PolarisBoot>` and SwiftUI `PolarisBootView` (report §8 item 6; not owned by
  any work package yet), a terminal renderer for Node and Python (optional).
- Implementing the boot guard (slots, staged swaps, restarts) (→ [P3-10](P3-10-godot-updater.md));
  its rows are decided here (decision 5).
- Pack rows for `fetch`/`mount` (size disclosure, cellular choice, pause, ordered mounts)
  (→ [P4-08](P4-08-godot-packs.md) with [P4-04](P4-04-content-corpus-v1.md)).
- The update decision itself (→ P3's `update-matrix.json`); here `decide` takes its result as an
  input.
- `sdks/*/parity.json` entries (after [P1b-01](P1b-01-parity-registry.md)).

## Design notes

**Proposed shape** (the plan confirms or changes each name):

- **Stages:** `shell`, `guard`, `sync`, `gate`, `decide`, `fetch`, `mount`, `ready`,
  `background`; terminal outcomes `ready`, `blocked`, `offline`, `error`, and `waiting` while the
  gate needs the player (activation or sign-in).
- **Events the host feeds** (results of work the host does; the machine does no I/O and reads no
  clock): `start {allowOffline, requiredPacks}`, `shell.done {cache: valid|none}`,
  `guard.done {result: ok|rolled-back|applied}`, `sync.done {result: ok|offline|error}`,
  `sync.timeout`, `gate.status {status}` (a `LicenseStatus` from `licenseState`),
  `gate.resolved {status}`, `decide.done {decision: none|optional|required}`,
  `fetch.done {result, missingRequired}`, `mount.done`, `retry`, `play-offline`,
  `background.done`.
- **Events the machine emits:** `stage_changed {stage, previous}`, `update_available`,
  `blocked {reason: update-required|not-available}`, `offline {canPlayOffline}`,
  `error {code}`, `boot_rolled_back`, `ready`.
- **Rules to pin with rows:** `not-applicable`, `ok` and `grace` pass the gate; `needs-activation`
  and `revoked` wait for `gate.resolved`; `expired` without network goes `offline`;
  `version-too-old` blocks with `update-required`; `version-too-new` and `channel-not-entitled`
  block with `not-available`; a sync timeout or offline result with a valid cache continues when
  `allowOffline`; without a usable cache it goes `offline` with `canPlayOffline: false`;
  `retry` returns to `sync`; `play-offline` reaches `ready` only when the required set is present
  and the gate is usable; a `required` decision blocks; `optional` continues and emits
  `update_available`; `rolled-back` continues and emits `boot_rolled_back`.
- **Row format**, like `gate-matrix.json`: `name`; `init` (`allowOffline`, `requiredPacks`);
  `events` (the ordered inputs); `expect` (`stages`, `emits`, `outcome`). Start with about 20 rows
  covering every rule above.

**Decisions for the human** (with recommendations):

1. Are stages with nothing to do still entered? **Recommend yes**, in order, exiting at once, so
   renderers can rely on the sequence; P1 hosts send `guard.done ok` and `fetch.done ok`
   immediately until P3-10 and P4-08 fill them.
2. File placement: `conformance/corpus/v2/stage-matrix.json` with its own version constant,
   **recommended**, so runners keep pointing at one directory.
3. How later phases extend the file: append rows and bump `stageMatrixVersion`, each under its
   own plan.
4. Timeouts are host-owned (the host sends `sync.timeout`), **recommended**, so the matrix stays
   clock-free.
5. Pin the boot-guard rule now? PARITY proves `update.bootguard` with this file, but P3-10 is
   neither plan-mode nor corpus-gated. **Recommend yes:** a `guard` input
   (`{staged, failedBoots}`) with rows for "apply the staged update", "roll back after two failed
   boots and emit `boot_rolled_back`" and "confirm a boot", so P3-10 only implements it.

**SDKs that follow, and when** (the plan must restate this):

| SDK        | What                                                 | Work package                   |
| ---------- | ---------------------------------------------------- | ------------------------------ |
| Node       | uses `client-core` directly; the Node runner section | this one                       |
| React      | uses `client-core` directly; no renderer yet         | this one (renderer unowned)    |
| Python     | a pure port and a pytest runner                      | this one                       |
| Swift      | a pure port and an XCTest runner over the mirror     | this one                       |
| Godot      | a port driving `PKeyBoot`, and the runner section    | [P1-10](P1-10-godot-ui-kit.md) |
| Kotlin, C# | ports when those SDKs exist                          | P6-05, X-01                    |

If the Python and Swift ports push this package past its estimate by more than half, the plan
proposes moving them to a follow-up and marking `ui.stages` `planned` for those SDKs.

- **No wire change.** Nothing here is signed, `PROTOCOL_VERSION` stays 3 and `corpusVersion`
  stays 2; the new file only adds a family.
- One corpus-touching package in flight at a time ([program README](../README.md) §5).

## Steps

1. Write the plan with the row list; set `awaiting-approval`; stop.
2. After approval: write `stages.ts` and its unit tests.
3. Add `buildStageMatrixV1()` and the mirrors; run `pnpm gen:corpus`; commit the outputs.
4. Add the Node runner section, then the Python and Swift ports and runners, one SDK per commit.
5. Update the corpus docs and `gen-reference.mjs`; regenerate the reference pages.

## Acceptance criteria

- [ ] The approved plan is merged before the first code commit.
- [ ] `conformance/corpus/v2/stage-matrix.json` and its Swift and Godot mirrors are generated,
      byte-identical, and `pnpm gen:corpus -- --check` fails if any of them changes.
- [ ] `mise exec node@22 -- pnpm --filter @polaris-key/client-core test` and the Node runner pass
      every row, asserting the stage sequence, the emitted events and the outcome.
- [ ] `( cd sdks/python && .venv/bin/python -m pytest -q tests/test_stage_matrix.py )` and
      `( cd sdks/swift && swift test --filter StageMatrixTests )` pass every row.
- [ ] `bootTransition` is pure: no I/O, no clock, no randomness (a unit test calls it twice with
      the same input and compares).
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes and the corpus page lists
      `stage-matrix.json`.
- [ ] The green gate passes (`AGENTS.md`), Python and Swift included.
- [ ] Parity manifests mark `ui.stages` implemented for Node, React, Python and Swift (once P1b-01
      has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm conformance
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
```

## Hand-off

- `@polaris-key/client-core/stages` (`bootTransition`, the stage, event and outcome names) and
  `stage-matrix.json`: P1-10 ports them to GDScript under the same names in snake_case and loads
  the Godot mirror in its runner.
- P3-10 (guard rows) and P4-08 (pack rows) extend the same file under their own plans.
- Renderers other than Godot are unowned; record that in the plan so the lead can schedule them.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-09 done`.
