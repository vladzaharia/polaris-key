# UK-43 Activation without an account in the native kits: SwiftUI, Compose, Godot, Qt and the terminals adopt UK-42's Done step, recommendation, **Add your name and email** and the key-ownership states with native controls

| Field       | Value                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                    |
| Depends on  | [UK-42](UK-42-activation-holders-web.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-31](LX-31-holders-closeout.md)                                                                                                                                              |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                      |
| Gates       | UI snapshots per kit in both themes; modernity lint; UI fixtures in every SDK                                                                                                                                           |
| Human input | none                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                               |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> In the rebuilt native kits only. LX-31's global default waits for it; LX-39's per-product flips do not.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: appends its rows to `ui-matrix.json` (§4.8).

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** As each kit's own row (UK-07, UK-08, UK-09, UK-10, UK-11, UK-12, and the [terminal form](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#terminal-form)).
- **In this kit:** Each kit renders UK-42's states with its own adaptation from the application matrix. Native fields carry the name and email content types; macOS uses title case; the terminals print one recommendation line with the portal URL.
- **Minimum check:** Each kit's minimum rows from its own row, for every UK-42 state.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
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
