# UK-45 Node terminal kit 0.8.x fixes

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                                                    |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`                                                                                            |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Goal

Node terminal kit 0.8.x fixes, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-45) and §10.4.

## Scope

**In:** devices "last seen" from the roster in seconds; status holder is name or email (empty counts as absent) and signed-in comes from `identity.current()`; login ends "Signed in as <name>" and confirms before attaching when a key licence is held (`waitForSignIn({confirm})`, default No); every flow ensures discovery before deciding a capability is off; `update apply` names the reason and next step (the upgrade command for package-manager installs, a download link otherwise; update copy for not-configured); interim refusal copy covering expiry with the portal link; `core.gate.revoked` not titled "Signed out" for key-only devices; product-first strings; one spelling of licence; `secret` and `mint` never print values without `--reveal`; catalog labels for tiers, platforms and settings; OSC 11 skipped when the theme is already decided.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Goldens with a real client's status (ms `lastVerifiedAt`) and an empty-email profile.
- [ ] A key-held login prompts, defaults to No and keeps the key licence.
- [ ] `login` works from the documented factory without a manual `discover()`.
- [ ] `update apply` goldens for npm, pnpm, brew, npx, no driver and not-configured each end in an actionable line.
- [ ] A lint finds no kit string naming Polaris Key where the product fits.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-45 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-45 done`.
