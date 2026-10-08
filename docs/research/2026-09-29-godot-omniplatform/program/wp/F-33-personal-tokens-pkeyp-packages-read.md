# F-33 Personal tokens (`pkeyp_`, `packages:read`) and portal Packages

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)                                                                                                                     |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                               |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [F-34](F-34-feeds-that-provision-themselves.md), [F-37](F-37-pkey-feeds-setup-write-cli-naming.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                   |
| Gates       | `migration`, `table-owners`, `threat-model`                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Goal

Personal tokens (`pkeyp_`, `packages:read`) and portal Packages, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **FX-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- An account*tokens table (pkeyp*, HMAC under the pepper, shown once, expiry, last used; scopes are exclusive per token: packages:read, or the admin scope ST-34 adds); the registry host accepts pkeyp* packages tokens, licence-bound pkeyr* and pkeyci* service tokens with packages:read, and refuses any admin token; it resolves a person per owner: the Library's usable licences under each feed's access mode, plus role-granted products, plus the system product's SDK listing for console members (owner decision 3); serve-time filtering of list documents; portal Account -> Packages with one combined setup across every product the account can read; console account menu -> Personal tokens; new product service tokens are minted as pkeyci* with packages:read (registry*tokens keeps only licence-bound tokens; existing owner-bound pkeyr* tokens are honoured until they expire); the portal stops minting licence-bound tokens (existing ones honoured); cascades on account delete, merge and membership removal; THREAT-MODEL entry; an authenticated registry-clients.yml row over two owners.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-01**; DX consolidation I: Packages, updates and packs.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One token installs every package the account may read, across products
- [ ] Customers never see the system product in listings
- [ ] Existing pkeyr* tokens keep working until expiry; new service tokens are pkeyci*
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-33 done`.
