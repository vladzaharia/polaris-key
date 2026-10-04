# I-10b SDK identity v2 for layer 1 in Swift, Kotlin and Godot (Godot first) plus `PolarisKeyUI`, the Kotlin activation component and the Godot UI: the same calls and refusals as I-10a, device-code passthrough with QR

| Field       | Value                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                         |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                                                                        |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md)                                                                                                       |
| Unblocks    | [I-13](I-13-exchange-endpoint.md), [I-15](I-15-native-redirect.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                           |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                              |
| Gates       | plan mode; all six SDKs (`parity:check`); `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; UI kit screenshots; CI: macOS; CI: Android                                                 |
| Human input | none                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                      |

## Goal

Swift, Kotlin and Godot (Godot first) handle layer 1 identity with the same calls and refusals as I-10a, using device-code passthrough with a QR code; `PolarisKeyUI`, the Kotlin activation component and Godot's `addons/polaris_key/ui` show the refusals and the "add to your Library" prompt.

## Why

The game program needs Godot first, and this half is the estimate most likely to slip ([S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK API table), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-10b.
- `sdks/godot/addons/polaris_key/`, `sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift:107-125`, `sdks/kotlin/`.

## Scope

**In:**

- In Godot, then Swift and Kotlin: refusal handling, device-code passthrough with QR and P1-07 confirm-and-attach, `attach`, `subject`, `signOut` (Cloud Sync flush when on), `openAccount`.
- UI kits: refusal screens, QR, "N activations left", "add to your Library".
- Transcript replayers and parity rows.

**Out** (and where it belongs instead):

- Node, React, Python (→ I-10a); `exchange` and platform sign-in helpers (→ I-13, I-14); native redirect (→ I-15).

## Design notes

- Godot's existing device-code QR is the base; Swift's `PolarisLoginView(onSignIn:)` stops defaulting to a no-op.
- Same refusal rules and copy as I-10a.

## Steps

1. Godot SDK and UI.
2. Swift and `PolarisKeyUI`; Kotlin and its component.
3. Replayers, parity rows, screenshots.

## Acceptance criteria

- [ ] Each SDK replays the I-08 and I-09 transcripts (tests).
- [ ] Neither refusal clears stored licence state (test per SDK).
- [ ] UI kit screenshots for both refusals in all three kits.
- [ ] `parity.json` manifests updated for all three SDKs; macOS and Android CI green.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

- U-07 and U-21 build user settings on these calls; I-13 and I-14 add native sign-in.

The role agent sets `--set I-10b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-10b done`.
