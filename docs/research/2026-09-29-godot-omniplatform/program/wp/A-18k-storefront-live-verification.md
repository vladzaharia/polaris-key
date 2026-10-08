# A-18k Live verification of the storefront credentials and the [U] items of S-15

| Field       | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                                                                                                                            |
| Size        | 0.5–1 engineer-weeks                                                                                                                                                                                                                                  |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md)                                                                                                                                                                                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                                                                    |
| Gates       | human approval of every live write                                                                                                                                                                                                                    |
| Human input | the Play service account with the decision-4 permissions; the Partner Center Entra application and seller id; the Steamworks group-scoped publisher key; a fine-grained GitHub token; the owner's approval of each write, given by the owner directly |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                             |

**Status: blocked** on the owner's credentials and approval. An approval relayed by an agent is not
the owner's consent (as with A-17h, S-14 §12 decision 3).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track A, Ground truth, decisions and quick wins](../../../2026-10-07-dx-consolidation/tracks.md#a-ground-truth-decisions-and-quick-wins)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Still blocked on the owner's store credentials (owner step). A per-store gate on production automation, not a build dependency: A-23 and A-33 build without it, and each store's runner rows stay human steps until A-18k verifies that store. Add the commerce live checks: App Store Server Notifications set/verify/test round trip, Play RTDN test, group-scoped Steam CheckAppOwnership, Microsoft Store collections read.

## Goal

Every [U] item in S-15 §12 is resolved by a call in the owner's accounts, read-mostly, and the
results are recorded in a dated addendum to
[notes/S-15](../../notes/S-15-storefront-provisioning.md), as A-17h did for S-14.

## Why

S-15 made no account call. Several design choices wait on facts only an account can show:
decision 5 (Steam public branch) and decision 7 (winget token type) are conditional on this
package ([S-15 §12, §13](../../notes/S-15-storefront-provisioning.md#12-limits-of-this-spike)).

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) §4, **§12**, §13 decisions 4, 5, 7.
- [notes/S-14](../../notes/S-14-asc-provisioning.md) §12 and the A-17h results section (the
  pattern for an addendum).

## Scope

**In** (each read-only unless the owner approves the write):

- Play: whether "Manage store presence" suffices for listing and image writes; the edit expiry;
  the per-minute quota behaviour (no header).
- Microsoft: Developer versus Manager role; real `Retry-After` values; whether a `packageUrl` that
  redirects to a signed R2 link is accepted.
- Steam: whether the group-scoped key may call `SetAppBuildLive` with `betakey=public`, against a
  named branch.
- winget: whether a fine-grained GitHub token can open a PR on `microsoft/winget-pkgs`.
- IARC: whether Play's form imports an existing certificate.
- Every guessed deep-link shape in `core/storefront/deeplinks.ts`, clicked by a person.

**Out:**

- Any delete, user, payment or signing-key operation, in any account, even to clean up. Cleanup is
  by hand in the vendor's UI.

## Acceptance criteria

- [ ] A dated addendum in notes/S-15 records each item with evidence.
- [ ] Follow-ups are filed for any rule change the results imply: the Steam public-branch rule to
      typed confirmation (decision 5), the winget token type (decision 7), any Play permission
      change, the deep-link table fixes.

## Hand-off

A-18g, A-18i and A-18e apply the results through follow-up changes. When the inputs arrive, the
lead sets this package to `todo` and dispatches it.

The role agent sets `--set A-18k in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18k done`.
