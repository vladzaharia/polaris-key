# F-33b `pkeyci_` packages:read, serve-time list filtering, the registry-clients two-owner row, revoke licence-bound tokens on unlink

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs) |
| Size        | 0.2–0.25 engineer-weeks                                                          |
| Depends on  | [F-33](F-33-personal-tokens-pkeyp-packages-read.md)                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                           |
| Role        | `pkey-implementer`                                                               |
| Plan mode   | no                                                                               |
| Gates       | `migration`, `table-owners`, `threat-model`                                      |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Split 2026-10-22 (triage)

Filed from [F-33](F-33-personal-tokens-pkeyp-packages-read.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 8–10 h). F-33 carries what is on staging; this package carries the rest.

On staging already: F-33 slices 1 and 2 on staging (2db897218, 9e2ae1609): `core/accounts/personalTokens.ts`, migration 0120, `/api/me/tokens`, `personMayRead`, the portal Packages card and the console Personal tokens page.

## Goal

`pkeyci_` packages:read, serve-time list filtering, the registry-clients two-owner row, revoke licence-bound tokens on unlink. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [F-33](F-33-personal-tokens-pkeyp-packages-read.md), its Progress and Split notes.

## Scope

**In:**

- Slice 3 of F-33 (security-relevant): (a) new product service tokens minted as `pkeyci_` with `packages:read` (a CI scope, the console feeds handler, the registry host change), 3–4 h; (b) serve-time filtering of list documents per ecosystem adapter (entitled packages the person does not hold), 3–5 h; (c) the authenticated `registry-clients.yml` row over two owners, 1 h; (d) revoke licence-bound tokens on unlink (security note). Role-granted and console-member access in `personMayRead` is NOT here: it moved to ST-31/ST-34.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything F-33 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] New product service tokens are `pkeyci_` with `packages:read`; `registry_tokens` keeps only licence-bound tokens
- [ ] List documents are filtered at serve time per ecosystem adapter
- [ ] The `registry-clients.yml` row over two owners exists
- [ ] Unlinking a licence revokes its licence-bound tokens (test; threat-model row)
- [ ] Existing `pkeyr_` tokens keep working until expiry
- [ ] Security review signed
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set F-33b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-33b done`.
