# SP-18 Swift `config.setting(key)` and `onConfigChange(key, listener)` over the existing `LocalConfigStore` (`config.local`)

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps) |
| Size        | 0.2–0.3 engineer-weeks                                    |
| Depends on  | none                                                      |
| Unblocks    | none                                                      |
| Role        | `pkey-sdk-porter`                                         |
| Plan mode   | no                                                        |
| Gates       | `swift test`; `parity:check`; the generated parity page   |
| Human input | none                                                      |
| Repo        | `vladzaharia/polaris-key`                                 |

## Goal

Swift's `config.local` matches §3.11: besides `set`, `clear` and `clearAll` (which persist through `LocalConfigStore`, validate against the catalog and raise `client.events .config`), `config.setting(key)` returns the effective value with its source and `onConfigChange(key, listener)` delivers per-key changes (also as an `AsyncStream`).

## Why

The row is planned only because `setting(key)` and `onConfigChange` are missing; the rest is built and tested (`LocalConfigTests`). The parity rows it owns: `config.local` in `sdks/swift/parity.json`; their `note` fields give the current state. It absorbs the parity note's the rest of SP-S14 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.11.
- `sdks/swift/Sources/PolarisKeyConfig/` and `LocalConfigTests`.
- Node's `client.config.setting/onConfigChange` as the reference.

## Scope

**In:**

- `config.setting(key)` and `onConfigChange(key, listener)` with a cancellable handle.
- Tests for both.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Cloud Sync state (→ phase U).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Keep S-17's names exactly.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature config.local` tests cover persist, clear, type refusal, `setting(key)` and per-key change delivery.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- U-06/U-20 add sync state under this API.

The role agent sets `--set SP-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-18 done`.
