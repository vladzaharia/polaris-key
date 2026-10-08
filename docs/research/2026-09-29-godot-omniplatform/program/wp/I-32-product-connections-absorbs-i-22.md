# I-32 Product connections (absorbs I-22)

| Field       | Value                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                                               |
| Size        | 1.4–2 engineer-weeks                                                                                                                                                            |
| Depends on  | [I-30](I-30-connections-one-oidc-relying-party.md), [I-08](I-08-app-passthrough.md), [I-13](I-13-exchange-endpoint.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PS-08](PS-08-product-idp-path.md)                                                                                                      |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                           |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-32.md` first; no code before a human approves it                                                                                       |
| Gates       | `plan-mode`, `migration`, `table-owners`, `threat-model`                                                                                                                        |
| Human input | plan approval (`plans/I-32.md`)                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                       |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-05** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

- Owner 2026-10-07: no compatibility window. What this package replaces (a route, mode, shape, Action input or CLI form) is removed in the same release; the one exception is a path that native app binaries already on end-user machines call (DJDL's desktop builds, the permanent alias routes), removed once DJDL has shipped a build on 0.9 (`tracks.md` rule 6).
- Absorbs I-22: Bring-your-own-auth becomes a product connection with exchange: true; firebase is an oidc connection with a JWKS override.

## Goal

Product connections (absorbs I-22), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-05** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.4, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.4, §5, for **IX-05**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- A product-scoped connection used on that product's card (button and domain routing in product context) and at /<p>/identity/token when exchange: true (JWKS-verified ID token; firebase as an oidc connection with a JWKS override); tenant-scoped links (product:<slug>) never vouch email_verified (the email gate's code applies); migration of oidc.provider: custom products (config into a connection, sub-keyed licences claimed at next sign-in, an email-less count, an owner-set sunset); after the sunset licenses.sub stops being an owner key (release N: no read or write; the column stays dormant, and dropping idx_licenses_sub ships a new 00XX_index_assertion.sql in release N+1), and oidc_config and /<p>/identity/auth/{start,callback,choose} retire; old redirect URIs 302 during the window. Plan mode: exchange kinds are advertised in discovery.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-05**; DX consolidation F: Identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/I-32.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Custom issuers migrate without losing licences
- [ ] THREAT-MODEL row for tenant-minted identities
- [ ] Plan approved before code
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-32 done`.
