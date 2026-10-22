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

## Verified against the code (F-33b.1)

Checked on `integ/next-stage` (2026-10-22). Where this brief disagrees, the code is the fact.

- **(b) List documents already filter per deliverable.** Each listed package runs `authorizeFeedRead` with its own deliverable id, so person and licence principals are judged per package: PyPI simple index `services/distribution/registry/pypi/routes.ts:180-215`, Godot `listedPackages` `godot/routes.ts:168-190`, Swift identifiers `swift/routes.ts:460-500`. Cargo `config.json` names no package; npm, Maven, Go and OCI have no owner-level list. Item (b) becomes a cross-adapter conformance pin (F-33b.5), not new code; it fixes only a leak the pin finds.
- **(d) Account-minted licence-bound tokens are already revoked** on detach, relink and account deletion (`onLicenseOwnershipEnded`, `core/accounts/subjectHooks.ts`), and re-checked at serve time (B-155, `registryTokens.ts` `resolveRow`). The gap was operator-minted ones (`portal_account_id IS NULL`), which outlived an ownership change. F-33b.1 closes it: the hook also revokes those, as `system`.
- **Merge undo (deviation, B2).** Undo revokes every operator-minted token of each licence handed back, including ones minted for the returning account before the join (the hook cannot tell them apart). Decision: keep the over-revoke; it fails closed and the operator can re-mint. Pinned in `portalLinkAccounts.test.ts` (pre-join and window). The plan said merge undo was unchanged; that was wrong.
- **One batch, an audit row, a skip flag.** The hook's two statements run in one `db.batch`; the operator half writes a `registry_token.revoke_all` audit row (platform actor, licence and count, no token); `settleLoser` passes `operatorTokens: false` because the winner keeps the licence. The revoke still runs after the move's own batch commits; folding it into that batch is a follow-up.
- **(a) `pkeyci_` already reads with `release:publish`** (`CI_FEED_READ_SCOPE`). F-33b.2 adds the read-only `packages:read` scope.
- **C4.** Role-granted access in `personMayRead` is ST-31.9's. No root-only Superadmin hook is added (D-F7).

## Closeout (F-33b.7, 2026-10-22)

- **Lead decision: minting a durable credential needs a fresh step-up.** The service-token mint (`binding: "service"`, a `(body)` row checked in the handler), `POST …/ci-tokens` and `PUT …/ci-publisher` (table rows with `stepUp: true`) refuse with 403 `step_up_required` without a console sign-in from the last 5 minutes. Revokes stay without one. The three dialogs (New token, Issue token…, the trusted-publisher drawer) turn into "Sign in again" and reopen with their entries.
- **Correction:** ST-30c's break-glass realm is not in this tree, so the "break-glass is refused first" test waits for ST-30c.1.
- **Docs:** `features/ship-builds/packages/index.md`, `build/install.mdx`, `start/concepts.md` (Service token row), `operate/console/keys-and-secrets.md`. `help/packages.md` names no per-product token. THREAT-MODEL: one "Service tokens (F-33b)" subsection.
- "Security review signed" stays open: the lead runs the final review.

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

- [x] New product service tokens are `pkeyci_` with `packages:read`; `registry_tokens` keeps only licence-bound tokens
- [x] List documents are filtered at serve time per ecosystem adapter
- [x] The `registry-clients.yml` row over two owners exists
- [x] Unlinking a licence revokes its licence-bound tokens (test; threat-model row)
- [x] Existing `pkeyr_` tokens keep working until expiry
- [ ] Security review signed
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set F-33b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-33b done`.
