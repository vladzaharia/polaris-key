# LX-02 OIDC sign-in stops renewing `expires_at` and changing tier on an existing licence; provisioning rewrites only its declared keys, secrets included

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.3–0.4 engineer-weeks                                                                  |
| Depends on  | none                                                                                    |
| Unblocks    | [LX-08](LX-08-licensing-expand.md)                                                      |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | THREAT-MODEL                                                                            |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

OIDC sign-in on an existing licence updates only `name`, `email` and `groups_json`, never `tier_id` or `expires_at`, and rewrites only the override keys the product's provisioning declares (entitlement and secret keys), so operator overrides survive and a time-limited tier no longer renews on every sign-in.

## Why

Today sign-in resets the tier, renews `expires_at` (endless trials) and replaces the whole `overrides_json` (G7, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decision 12 accepted the fix ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 12).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps) G7, [S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring) ("OIDC sign-in on an existing licence"), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-02.
- `packages/worker/src/services/identity/oidc.ts` (or its current home; verify).

## Scope

**In:**

- Sign-in writer change; surgical provisioning rewrite (declared keys only, removing a declared key whose claim disappeared).

**Out** (and where it belongs instead):

- Provisioned keys as `oidc` grants (→ LX-08).
- `syncTierOnSignIn: upgradeOnly` (→ LX-08, needs `tiers.rank`).

## Design notes

- Revocation on claim loss must keep working: that is why grants are not introduced here (§7.14 step 4).

## Steps

1. Tests first: trial ends, operator override survives, claim loss revokes.
2. Writer change.

## Acceptance criteria

- [ ] A trial licence's `expires_at` does not move on sign-in (test).
- [ ] An operator override of an undeclared key survives sign-in (test).
- [ ] A declared key is removed when its claim disappears (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-08 moves provisioned entitlement keys to `oidc` grants atomically.

The role agent sets `--set LX-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-02 done`.
