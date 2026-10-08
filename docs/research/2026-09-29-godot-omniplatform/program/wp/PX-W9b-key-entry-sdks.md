# PX-W9b Key-entry outcome in client-core and the six SDKs (G21): `readKeyEntries`, `keyEntries` on success, the `key-entry-limit` result with `manageUrl`, and the four UI kits' entries line and refusal screen (Add it in Polaris Key, QR without the key)

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                               |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                |
| Depends on  | none                                                                                                                                                                                  |
| Unblocks    | none                                                                                                                                                                                  |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                  |
| Plan mode   | yes: executes §5 of the approved [`plans/PX-W9.md`](../plans/PX-W9.md) (revision 2, approved by the lead under the owner's delegation, 2026-10-06; Q1, Q6)                            |
| Gates       | plan mode; all six SDKs (`parity:check`); `gen:constants -- --check`; `gen:brand -- --check`; transcripts (rule 1); UI kit snapshots, `ui:lint`, `ui:report`; CI on macOS and Android |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [I-10a](I-10a-sdk-identity-node-react-python.md) and [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [I-10a](I-10a-sdk-identity-node-react-python.md) and [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Same six-SDK activation surface as identity v2 (C-47): one pass instead of two.

- Dependencies cleared on closing (they were PX-W9 and PX-W8), so nothing in the graph waits on or through a closed package.
- `planRef` removed on closing (it executed PX-W9's plan, [`plans/PX-W9.md`](../plans/PX-W9.md)).

## Goal

Every SDK reads the key-entry members that PX-W9 puts on the wire, and every UI kit shows them:

- **On success,** an app knows how many key entries its licence has left.
- **On `key_entry_limit`,** it shows a refusal screen that sends the person to Polaris Key to add
  the key to an account. It never wipes state and never retries.

## Why

PX-W9 ships the Worker half of G21: the counter, `keyEntries`, the `key_entry_limit` refusal, the
error, enum and copy entries, and three transcripts. The operator can turn on the refusal switch
(`identity.keyEntryRefusals`) only once the SDKs show the refusal properly. Splitting the SDK
half out of I-10a and I-10b lets it ship without waiting for I-08 (`plans/PX-W9.md` Q1). I-10a
and I-10b later add the screen's **Sign in** action, which needs I-08.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [`plans/PX-W9.md`](../plans/PX-W9.md): the decisions, §2 (the §12.2 contract and the
  `keyEntries` member), §4 (the transcripts and parity rows) and §5 (this package).
- [`plans/PX-W8.md`](../plans/PX-W8.md) §5: the same path for `device_limit`. Reuse its
  `readManageUrl`, `withManageKey` and `withManageReturn` and its **Replace a device** screen
  structure.
- `docs/security/WIRE-CONTRACT-V4.md` §5.3 (refusal links, rule 5: no key in a QR) and §12.2
  (written by PX-W9).
- [SIGN-IN.md](../../../../design/SIGN-IN.md) §4.5 (the license-key on-ramp in the app) and
  §3.9 (KeyStep copy).
- `conformance/transcripts/keyentry-limit.json`, `keyentry-refusals-off.json` and
  `keyentry-identity-off.json` (PX-W9).

## Scope

**In:**

- **client-core** (`packages/client-core`):
  - `src/keyEntries.ts` with `readKeyEntries(body): KeyEntries | undefined`. It reads the top
    level, else the member under `error`. Both values must be safe integers, with `used ≥ 0` and
    `limit ≥ 1`; anything else answers `undefined`.
  - `keyEntriesLeft(e)`, which answers `max(0, limit − used)`.
  - The table `test/keyEntries.test.ts`, which every SDK repeats (Q6).
- **Every SDK, headless.**
  - The `ok` activation result gains `keyEntries`.
  - A new outcome, `key-entry-limit {code, manageUrl?, keyEntries?}`, read through the SDK's
    `readManageUrl` and `readKeyEntries`.
  - It replays the three transcripts and flips `identity.keyentry` to `implemented`.

  | SDK    | Files                                                                                                                                                                                                                                                                 |
  | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Node   | `src/license/endpoints.ts` (`ActivationResult`, `KIND_BY_CODE`), re-exports in `src/index.ts`, `src/cli/commands.ts` (prints the count left and the link)                                                                                                             |
  | React  | `src/core/activation.ts` (`classifyActivation`), `src/core/types.ts`, `src/browser/browserAdapter.ts` (the `session/license` 201 now carries `keyEntries`), `src/desktop/bridge.ts` and `src/desktop/desktopAdapter.ts` (pass it through), and the `useLicense` state |
  | Python | `license/endpoints.py` (`ActivationResult.key_entries`, kind `key-entry-limit`), `core/key_entries.py`, `cli/core.py`                                                                                                                                                 |
  | Swift  | `PolarisKeyCore/KeyEntries.swift`; `PolarisKeyLicense/Endpoints.swift` `.ok(token:schemaVersion:keyEntries:)` and `.keyEntryLimit(manageURL:keyEntries:)`. This is source-breaking, as PX-W8's `deviceLimit` change was; the 0.x release note says so                 |
  | Godot  | `core/key_entries.gd`; `services/license/activation_result.gd` (`KIND_KEY_ENTRY_LIMIT`, `key_entries` as a `Dictionary`), `services/license/endpoints.gd`                                                                                                             |
  | Kotlin | `core/…/KeyEntries.kt`; `license/…/LicenseEndpoints.kt` `Ok(…, keyEntries: KeyEntries? = null)` and `KeyEntryLimit(manageUrl, keyEntries)`, which stay source-compatible; `:conformance` `TranscriptTest`                                                             |

- **The four UI kits** flip `ui.kit.keyentry` to `implemented`:

  | Kit             | File                                                                    | QR shown when              |
  | --------------- | ----------------------------------------------------------------------- | -------------------------- |
  | React           | `src/components/PolarisLogin.tsx`                                       | –                          |
  | SwiftUI         | `PolarisKeyUI/PolarisLoginView.swift`                                   | tvOS                       |
  | Godot           | `ui/activation/activation_controller.gd` and `pkey_activation_panel.gd` | a joypad is the only input |
  | Compose (`:ui`) | `ui/…/PolarisGate.kt`                                                   | Android TV                 |
  - **Success line.** "{left} key entries left" (`signin.key.entriesLeftShort`).
  - **Refusal screen.**
    - The title and body are the core copy for `key-entry-limit`.
    - **Add it in Polaris Key** opens `manageUrl` through `withManageKey` and `withManageReturn`,
      as a button. Where a QR code is shown instead, it never carries the key.
    - **Use a different key.**

- **Kit copy.** `keyEntryLimit.manage` ("Add it in Polaris Key") and `keyEntryLimit.scan` ("Scan
  to add it in Polaris Key") go into `packages/brand/kit-copy/en.json` and its eight locale packs
  (`de`, `es`, `fr`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`). Then run `pnpm gen:brand`.
- **Typed N/A.** Node and Python keep `ui.kit.keyentry` as N/A: `headless` (reason `runtime`).
  Hosts read `manageUrl` and `keyEntries` from the result.
- **Docs.** Each SDK's licensing guide gains a section, "When a key has no entries left". It
  states that the limit applies only to products with Identity on.

**Out** (and where it belongs instead):

- The Worker, the contract, `errors.json`, `enums.json` and the core copy packs (→ PX-W9).
- The refusal screen's primary **Sign in**, plus `license-owned`, attach, `subject`, `signOut` and
  `openAccount` (→ I-10a, I-10b; they need I-08 and I-09).
- The portal's meter and forced upgrade (→ PX-12).

## Design notes

- **Not an auth failure.** Neither the refusal nor the link is one. Never wipe stored licence or
  token state, never retry, and never open the link without a user action (WIRE-CONTRACT-V4
  §5.3 rule 6).
- **Identity off.** `keyEntries` is absent: show no line and no meter. Do not read its absence as
  an error.
- **Over the limit.** `used` may exceed `limit` (races, portal claims, periods with the switch
  off). Always show `keyEntriesLeft`, never a negative count.
- **Order.** The parity order is client-core, Node, React, Python, Swift, Godot, Kotlin. Godot may
  go first. Fix the per-language names in the PR description; they change no contract.
- **Copy.** Use the US "license" and SIGN-IN.md's vocabulary: "key entries", never "activations".

## Steps

1. client-core `keyEntries.ts` and its table.
2. The headless outcome in each SDK, with the table repeated and the three transcripts replayed.
3. Kit copy and `gen:brand`, then the four kits and their snapshots.
4. Flip both parity rows in each `parity.json`, add `@pkey-feature identity.keyentry` to each
   replayer, and write the docs and release notes.

## Acceptance criteria

- [ ] Each SDK repeats client-core's `readKeyEntries` table and replays the three `keyentry-*` transcripts (tests).
- [ ] Neither the refusal nor an absent member clears stored state (test per SDK).
- [ ] With Identity off, no SDK or kit shows an entries line (test per SDK against `keyentry-identity-off.json`).
- [ ] A QR code never carries the key (test per kit that draws one).
- [ ] UI kit snapshots for the entries line and the refusal screen in React, SwiftUI, Godot and Compose.
- [ ] `identity.keyentry` is `implemented` in all six `parity.json`, and `ui.kit.keyentry` is `implemented` in the four kits and N/A `headless` in Node and Python.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm parity:check && mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm gen:brand -- --check && mise exec node@22 -- pnpm ui:lint && mise exec node@22 -- pnpm ui:report
mise exec node@22 -- pnpm --filter @polaris-key/node test && mise exec node@22 -- pnpm --filter @polaris-key/react test
( cd sdks/python && .venv/bin/python -m pytest -q ); ( cd sdks/swift && swift test ); sdks/godot/tools/run_tests.sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :core:test :license:test :sdk:test :conformance:test )
```

## Hand-off

- I-10a and I-10b add **Sign in** as the refusal screen's primary action, with `license-owned`
  beside it.
- Once this package and those two ship and the I-19 docs have warned developers, an operator may
  turn on `identity.keyEntryRefusals`.

The role agent sets `--set PX-W9b in-review` when it hands off. After review, the lead adds the
last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W9b done`.
