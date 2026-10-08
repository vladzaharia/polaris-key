# ST-34 Admin-scope personal tokens and pkey login

| Field       | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity)                                               |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                   |
| Depends on  | [F-33](F-33-personal-tokens-pkeyp-packages-read.md), [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md), [P0-45](P0-45-pkey-command-registry-context-doctor.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                     |
| Gates       | `threat-model`                                                                                                                                                         |
| Human input | none                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                              |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-07** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- Owner 2026-10-07: no compatibility window. `PKEY_ADMIN_COOKIE` goes from the CLI and the docs in the same release as the admin-scope tokens (`tracks.md` rule 6).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: the token principal comes from `resolvePrincipal`, and SM-1 applies to minting. It removes `PKEY_ADMIN_COOKIE` from the CLI, the Action bundle and the docs in the same release as `pkey login`.
- [`plans/I-27.md`](../plans/I-27.md) §12: §2.5's lifetimes, device login with `purpose: "cli"`, and the phishing row.

## Goal

Admin-scope personal tokens and pkey login, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-07** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, for **AC-07**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- The admin scope on account*tokens: role-bounded at use time, step-up to mint, at most 30 days; scopes are exclusive per token (admin or packages:read, never both): the admin API accepts only Authorization: Bearer pkeyp* tokens with the admin scope (bearer only, no cookie, no CSRF), and the registry host refuses any token that carries admin; pkey login, whoami and logout by device code in console context with an OS-keychain store; pkey bundle and listing import move to it; PKEY_ADMIN_COOKIE removed after 30 days with no cookie-authenticated CLI call (P0-24 ledger); recipes in build/onboarding.md:306 and agents/recipes.md:117 replaced.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-07**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A token never exceeds its holder's roles at use time (test)
- [ ] An admin-scope token is refused by the registry and a packages token by the admin API (test)
- [ ] No `PKEY_ADMIN_COOKIE` in the CLI, the Action bundle or the docs in the release that ships `pkey login`
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-34 done`.
