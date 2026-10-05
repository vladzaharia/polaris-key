# UK-40 Kotlin JVM desktop parity (SP-K12): OS keyring store (Keychain, Credential Manager, Secret Service), desktop updater driver over `release.fetch`, default `UpdateSlots`

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must) |
| Size        | 2–3 engineer-weeks                                                           |
| Depends on  | none                                                                         |
| Unblocks    | [UK-10](UK-10-compose-desktop.md)                                            |
| Role        | `pkey-sdk-porter`                                                            |
| Plan mode   | no                                                                           |
| Gates       | Kotlin JVM suites on Linux, macOS and Windows; `parity:check`                |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Goal

A Kotlin JVM desktop app stores its credentials in the OS keyring and installs updates through a desktop driver, so the Compose Desktop kit (UK-10) has full parity with Android.

## Why

The owner gave Kotlin JVM desktop full parity on 2026-10-05: kit, keyring and updater. This package is SP-K12 of the parity note; when the lead schedules the SP-K wave, SP-K12 is closed by UK-40 and not created again. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- `notes/SDK-PARITY-PASS.md` §2.5 (JVM desktop) and §5.5 SP-K12
- `sdks/kotlin/` storage and update modules

## Scope

**In:**

- An OS keyring store (Keychain, Credential Manager, Secret Service via `java-keyring` or JNA), keeping the `dependency` N/A when absent.
- A desktop install driver: download the installer for the OS and arch through `release.fetch`, verify, open.
- Default `UpdateSlots`; `parity.json` updates.

**Out** (and where it belongs instead):

- The Compose Desktop UI (→ UK-10).
- Kotlin `release.fetch` itself if missing (→ the SP-K13 task; this package adds a minimal fetch if SP-K13 has not landed and says so in the PR).

## Design notes

- No wire change.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] The keyring store passes the storage contract tests on macOS, Windows and Linux CI (Secret Service under a headless session or skipped with a recorded N/A).
- [ ] The driver verifies the installer's digest before opening it.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :core:test :update:test :sdk:test )
```

## Hand-off

UK-10's UpdatePrompt drives the updater and its sign-in uses the keyring store.

The role agent sets `--set UK-40 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-40 done`.
