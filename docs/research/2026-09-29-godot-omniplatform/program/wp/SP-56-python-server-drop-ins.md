# SP-56 Python server drop-ins: `polaris_key.server` with FastAPI/Starlette, Django and DRF, Flask

| Field       | Value                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                           |
| Size        | 1.4–1.9 engineer-weeks                                                                                                                                                                                                                                                     |
| Depends on  | [SP-53](SP-53-backend-credential-contract.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md)                                                                                                                                                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md), [SP-67](SP-67-developer-webhooks-delivery-and-adapters.md), [SP-68](SP-68-requiresignin-accepts-i21-tokens.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                         |
| Gates       | `drift-gate`                                                                                                                                                                                                                                                               |
| Human input | none                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                  |

## Plan follow-through (2026-10-09)

Approved [`plans/SP-53.md`](../plans/SP-53.md) and [`plans/SP-54.md`](../plans/SP-54.md) (2026-10-09) bear on this package; where they differ from the text below, they win.

- **Dependency.** Depends on SP-53 (the verdict, `backend-matrix.json`) and now also on SP-54: `requireSignIn()` reads `profile.user.subject` through its own port of the `licenseUserOf` rule, and replays `licenseUserCases` plus the `verdict` rows.
- **Corrections.** The privacy file is `docs/PRIVACY.md`; there are eight locales, not nine (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`); `tools/gen-sdk-constants.test.ts` pins the `sdkId` list, which already holds this package's `<lang>-server` value after SP-53.
- **Sequencing.** SP-53 merges first, then SP-54 rebases, swaps SP-53's private subject decoder for `licenseUserOf` and runs the one batched `pnpm gen corpus` after UK-03. This package builds on the integrated tree and regenerates nothing.

## Goal

Python server drop-ins: `polaris_key.server` with FastAPI/Starlette, Django and DRF, Flask, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-56.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-56).

## Scope

**In:** `polaris_key.server` (the core) plus `.fastapi`/`.starlette`, `.django`, `.drf` and `.flask`, each a thin adapter over the core; the `[fastapi]`, `[flask]` and `[django]` extras pin floor versions and the adapters import lazily. The §5.1 verdict, `PolarisAuth`, `require_license`/`require_entitlement`/`require_sign_in`, `on_refusal`, and `errors="throw"` as the DRF default (`AuthenticationFailed`, `PermissionDenied` shaped by `EXCEPTION_HANDLER`). Replays `backend-matrix.json`.

**Out** (and where it belongs instead):

- The client half (→ SP-58); `serverClient()` config (→ SP-63).

## Design notes

- Each adapter is about a hundred lines over one core, so all three are must (§5.3).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A gated FastAPI, Django/DRF and Flask route answers each §5.2 verdict.
- [ ] The core needs only `cryptography` and `httpx` (already dependencies); adapters import lazily.
- [ ] No token or holder PII in logs or `repr`.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-56 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-56 done`.
