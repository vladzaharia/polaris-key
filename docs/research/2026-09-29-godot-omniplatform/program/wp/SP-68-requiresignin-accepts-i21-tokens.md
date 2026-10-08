# SP-68 `requireSignIn()` accepts I-21 issuer tokens (`Authorization: Bearer`, RS256 JWKS)

| Field       | Value                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                                          |
| Depends on  | [I-21](I-21-product-issuer.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md) |
| Unblocks    | none                                                                                                                                                                            |
| Role        | `pkey-sdk-porter`                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                              |
| Gates       | `all-sdks`, `drift-gate`                                                                                                                                                        |
| Human input | none                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                       |

## Goal

`requireSignIn()` accepts I-21 issuer tokens (`Authorization: Bearer`, RS256 JWKS), as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-68 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-68).

## Scope

**In:** `requireSignIn()` in every server drop-in also accepts an I-21 issuer access token on `Authorization: Bearer`, verified by RS256 against the product's JWKS, so an Identity-only product (no licence document) can gate on the signed-in subject.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- It reuses the pairwise subject SP-54 added, so a backend keyed on it needs no migration.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A route gated with `requireSignIn()` accepts a valid I-21 access token and refuses an invalid one.
- [ ] The subject matches the document's `profile.user.subject` shape.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-68 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-68 done`.
