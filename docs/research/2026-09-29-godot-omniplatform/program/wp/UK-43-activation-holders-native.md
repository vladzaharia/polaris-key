# UK-43 Activation without an account in the native kits: SwiftUI, Compose, Godot, Qt and the terminals adopt UK-42's Done step, recommendation, **Add your name and email** and the key-ownership states with native controls

| Field       | Value                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                    |
| Depends on  | [UK-42](UK-42-activation-holders-web.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md) |
| Unblocks    | none                                                                                                                                                                                                                    |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                      |
| Gates       | UI snapshots per kit in both themes; modernity lint; UI fixtures in every SDK                                                                                                                                           |
| Human input | none                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                               |

## Goal

SwiftUI (iOS, iPadOS, macOS), Compose (Android and desktop), Godot, Qt and the terminal kits show
the same Done step, recommendation, **Add your name and email** flow and key-ownership states as
UK-42, from the same fixtures, with native controls.

## Why

R6 of [S-24](../../notes/S-24-licence-holders.md): every kit looks like Polaris Key with the product
as the hero and keeps native controls. The states are defined once in UK-42's fixtures.

## Read first

- AGENTS.md and CLAUDE.md.
- [UK-42](UK-42-activation-holders-web.md) and its fixtures; [S-24](../../notes/S-24-licence-holders.md)
  §9.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.4, §2.1, §4.3, §4.8; [UK-07](UK-07-swiftui-ios.md),
  [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md);
  [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md).

## Scope

**In:**

- `ActivateDoneView` / `AddToAccountView` (SwiftUI), `ActivateDone(state)` / `AddToAccount(state)`
  (Compose), `PKeyActivateDone.tscn` / `PKeyAddToAccount.tscn` (Godot), `ActivateDone.qml` /
  `AddToAccount.qml` (Qt), and the terminal kits' one-line recommendation with the portal URL
  (browser presentation only).
- Native fields with `textContentType(.name)` / `.emailAddress` and their platform equivalents;
  `SignInWithAppleButton` and Credential Manager kept as the provider shortcuts.
- Title case on macOS ("Add Your Name and Email"), button order per platform (UI-KITS §2.1).
- Snapshots per kit for every UK-42 fixture state.

**Out:** the models and copy (→ UK-42); the SDK members (→ UK-44).

## Steps

1. One kit at a time from the fixtures: SwiftUI, Compose, Godot, Qt, terminals.
2. Snapshots in both themes; the modernity lint.

## Acceptance criteria

- [ ] Every UK-42 fixture state renders in each kit in both themes (snapshots).
- [ ] Add your name and email ends with the same licence id and a signed-in device in each kit's
      sample (manual run recorded in the PR, or the kit's integration test).
- [ ] The green gate passes (AGENTS.md), including each touched SDK's suite.

## Verify

```sh
( cd sdks/swift && swift test )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :sdk:test )
sdks/godot/tools/run_tests.sh
( cd sdks/python && .venv/bin/python -m pytest -q )
```

## Hand-off

None beyond LX-31's docs.

The role agent sets `--set UK-43 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-43
done`.
