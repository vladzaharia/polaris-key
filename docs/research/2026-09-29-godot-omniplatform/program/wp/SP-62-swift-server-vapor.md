# SP-62 Swift server drop-in: `PolarisKeyServer` building on Linux, and the Vapor package

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                  |
| Size        | 1.2–1.7 engineer-weeks                                                                                                                            |
| Depends on  | [SP-53](SP-53-backend-credential-contract.md), [SP-52](SP-52-swift-package-footprint.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md) |
| Unblocks    | none                                                                                                                                              |
| Role        | `pkey-sdk-porter`                                                                                                                                 |
| Plan mode   | no                                                                                                                                                |
| Gates       | `ci:macos`                                                                                                                                        |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Plan follow-through (2026-10-09)

Approved [`plans/SP-53.md`](../plans/SP-53.md) and [`plans/SP-54.md`](../plans/SP-54.md) (2026-10-09) bear on this package; where they differ from the text below, they win.

- **Dependency.** Depends on SP-53 (the verdict, `backend-matrix.json`) and now also on SP-54: `requireSignIn()` reads `profile.user.subject` through its own port of the `licenseUserOf` rule, and replays `licenseUserCases` plus the `verdict` rows.
- **Corrections.** The privacy file is `docs/PRIVACY.md`; there are eight locales, not nine (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`); `tools/gen-sdk-constants.test.ts` pins the `sdkId` list, which already holds this package's `<lang>-server` value after SP-53.
- **Sequencing.** SP-53 merges first, then SP-54 rebases, swaps SP-53's private subject decoder for `licenseUserOf` and runs the one batched `pnpm gen corpus` after UK-03. This package builds on the integrated tree and regenerates nothing.

## Goal

Swift server drop-in: `PolarisKeyServer` building on Linux, and the Vapor package, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-62 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-62).

## Scope

**In:** The product `PolarisKeyServer` inside `PolarisKey`, building on Linux with `apple/swift-crypto` used only on Linux (decision 6); a separate registry package `polaris-key.PolarisKeyVapor` for the Vapor middleware, so Vapor and NIO are not fetched by every iOS app. Replays `backend-matrix.json`.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- Needs SP-52's package-footprint work first so the Swift verifier builds on Linux (§13 Q6).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `PolarisKeyServer` builds and verifies on Linux; `PolarisKeyVapor` gates a Vapor route.
- [ ] An iOS app resolving `PolarisKey` pulls in neither Vapor nor NIO (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-62 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-62 done`.
