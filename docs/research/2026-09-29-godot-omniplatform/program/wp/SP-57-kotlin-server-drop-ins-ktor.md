# SP-57 Kotlin server drop-ins: `polaris-key-server` and the Ktor plugin

| Field       | Value                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                       |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                   |
| Depends on  | [SP-53](SP-53-backend-credential-contract.md)                                                                                                                                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-61](SP-61-spring-boot-starter.md), [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md), [SP-67](SP-67-developer-webhooks-delivery-and-adapters.md), [SP-68](SP-68-requiresignin-accepts-i21-tokens.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                                                                     |
| Gates       | `drift-gate`, `ci:kotlin`                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                              |

## Goal

Kotlin server drop-ins: `polaris-key-server` and the Ktor plugin, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-57.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-57).

## Scope

**In:** Gradle modules `im.plrs.key:polaris-key-server` (the core) and `-server-ktor` (the Ktor plugin). The §5.1 verdict, `PolarisAuth`, `requireLicense`/`requireEntitlement`/`requireSignIn`, `onRefusal` and `errors = throw`. Ed25519 verification through JCA. Replays `backend-matrix.json`.

**Out** (and where it belongs instead):

- Spring Boot (→ SP-61); the client half in Kotlin (→ SP-59).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A gated Ktor route answers each §5.2 verdict.
- [ ] Replays the `verdict` and `problem` sections green.
- [ ] No token or holder PII in logs.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-57 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-57 done`.
