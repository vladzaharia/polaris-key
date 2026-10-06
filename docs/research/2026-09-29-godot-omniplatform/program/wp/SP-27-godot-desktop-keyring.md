# SP-27 Godot desktop keyring stores (`core.store`): macOS Keychain through a macOS `PKeyApple` build, Windows Credential Manager through `pkey_win.dll`, Linux Secret Service, with file-store migration and a surfaced `keyring-error`

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                        |
| Size        | 1.5–2.5 engineer-weeks                                                                                           |
| Depends on  | [P5-05](P5-05-apple-plugin-package.md)                                                                           |
| Unblocks    | none                                                                                                             |
| Role        | `pkey-godot-engineer`                                                                                            |
| Plan mode   | no                                                                                                               |
| Gates       | the Godot runner on macOS, Windows and Linux CI; native plugin builds; `parity:check`; the generated parity page |
| Human input | none                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                        |

## Goal

On desktop exports `PKeyCore` picks an OS keyring store when its native piece is present (macOS Keychain, Windows Credential Manager, Linux Secret Service), migrates from the 0600 file store, surfaces failures as `keyring-error` and reports `store_status()` honestly; without the native piece the file store stays with a recorded `dependency` reason.

## Why

iOS (P5-05) and Android (P5-06) have platform stores; the desktop runtimes keep the file store and no package owned a desktop keyring (program README §9). The parity rows it owns: `core.store` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's SP-G11 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §5.6 SP-G11.
- `sdks/godot/addons/polaris_key/core/store/` (`store.gd`, `file_store.gd`, `keychain_store.gd`, `keystore_store.gd`).
- UK-40's keyring decisions (service `pkey:<product>`, account `device-token`, verified writes, file fallback).

## Scope

**In:**

- A macOS build of `PKeyApple` with the Keychain calls, a Credential Manager binding in `pkey_win.dll`, and a Secret Service backend (libsecret GDExtension or `secret-tool`).
- Selection, migration and failure surfacing as on iOS and Android.
- CI steps that run the store contract on each OS.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Shipping the native plugins as an addon package (SP-G10 in the note).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Match UK-40's key naming so a Kotlin and a Godot build of one product do not collide.
- Never silently downgrade: a keyring failure after a successful write is surfaced, not swallowed.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature core.store` tests pass on macOS, Windows and Linux CI against the real keyring (Linux may skip with a recorded N/A when no Secret Service is reachable).
- [ ] A migration test moves a file-store token into the keyring.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- UK-11's sign-in keeps its token in the keyring on desktop.

The role agent sets `--set SP-27 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-27 done`.
