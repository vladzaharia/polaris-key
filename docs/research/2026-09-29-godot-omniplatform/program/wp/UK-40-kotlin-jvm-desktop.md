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

## Decisions (lead-delegated, recorded at hand-off)

The owner delegated open questions to the lead; the recommended option was taken in each case.

1. **No new Gradle module.** The keyring store is `:core`'s `KeyringStore` over a `KeyringBackend`
   port, with `JavaKeyringBackend` binding java-keyring 1.0.4 as `compileOnly` (Android never
   carries JNA). The install driver (`DesktopInstallDriver`), its fetch (`OkHttpArtifactFetch`) and
   the default slots (`DirUpdateSlots`, `FileBootGuardStore`) are `:update`'s, and the desktop entry
   point (`PolarisKeyDesktop`, `DesktopOptions`) is `:sdk`'s. So the brief's Verify command covers
   the whole package and `checkModuleBoundaries` is unchanged.
2. **The `dependency` N/A.** A desktop app ships java-keyring at runtime. The Compose Desktop kit
   (UK-10) adds the `runtimeOnly` line. Without java-keyring, or with no reachable keyring, the token
   stays in the 0600 file, `status()` says `keyring-unavailable` and `supports(core.store)` answers
   `dependency`. `Capabilities.forStore` makes `supports(core.store)` follow the client's store, as
   in Python.
3. **The store follows Python's `KeyringStore`.** It uses service `pkey:<product>` and account
   `device-token`, writes are verified, the file is the fallback, reads are file-first, and it
   reports backend `keyring` on all three OSes. One addition: a `FileStore` token from an earlier
   build moves into the keyring on the first read that can verify the move.
4. **`release.fetch`.** SP-K13 has not landed and the ⊕ id is not in the registry, so this package
   adds the minimal fetch, `OkHttpArtifactFetch`, a port of Godot's `PKeyDownload`. It resumes with
   `Range`, keeps the bearer to the control plane's origin, refuses plain http off loopback and
   refuses an over-long body. No test carries a `release.fetch` tag. SP-K13 moves it behind the
   feature id.
5. **`update.driver` on the JVM.** The jvm `runtime` exception is removed from `parity.json`.
   `UpdateClient.install` replaces the default `JvmInstallDriver` marker with `desktopDriver` on a
   non-Android JVM, and `PolarisKeyDesktop` wires its own over the app's data directory. Called
   directly, the marker is still the typed `runtime` N/A. The driver handles `binary` with
   `download` or `native`, declines `sidecar-pck` and `store`, and opens the verified installer with
   `open`, `rundll32 shell32.dll,ShellExec_RunDLL`, `xdg-open`, or runs an AppImage directly.
6. **CI.** The new `kotlin-desktop` job runs a matrix over ubuntu-latest, macos-15 and
   windows-latest with `PKEY_KEYRING_TESTS=1`. On Linux, gnome-keyring is unlocked inside a
   `dbus-run-session`. Linux and macOS run `:core`, `:update` and `:sdk` whole. Windows runs the
   desktop suites only, because the other JVM suites have never run on Windows and making them pass
   there is outside this scope. A final step fails unless the real-keyring contract ran, with one
   exception: on Linux it may be skipped with the recorded N/A.
   Review round 2 correction: the test reads `PKEY_KEYRING_TESTS` at run time, so `:core`'s Test
   tasks declare it as an input, and the `kotlin-desktop` gradle runs pass `--no-build-cache`. A
   cached `:core:test` result recorded without the variable, which setup-java's Gradle cache could
   restore, can no longer stand in for the real-keyring run.

## Acceptance criteria

- [ ] The keyring store passes the storage contract tests on macOS, Windows and Linux CI (Secret
      Service under a headless session or skipped with a recorded N/A). _The contract
      (`KeyringStoreTest`) passed locally on macOS against the real login Keychain
      (`PKEY_KEYRING_TESTS=1`). The `kotlin-desktop` matrix runs it on all three OSes, but its first
      run is after the lead pushes, so this box is left for the lead to tick._
- [x] The driver verifies the installer's digest before opening it (`DesktopInstallDriverTest`: a
      digest or size mismatch removes the `.part` and opens nothing).
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header (the
      Kotlin JVM suites, `checkModuleBoundaries` and `parity:check` included).

## Verify

```sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :core:test :update:test :sdk:test )
```

## Hand-off

UK-10's UpdatePrompt drives the updater and its sign-in uses the keyring store.

The role agent sets `--set UK-40 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-40 done`.
