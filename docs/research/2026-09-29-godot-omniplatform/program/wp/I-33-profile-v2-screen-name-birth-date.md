# I-33 Profile v2: screen name, birth date, platform terms

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity) |
| Size        | 0.8–1.2 engineer-weeks                                                                            |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md)                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-21](PX-21-email-gate-ui.md)                           |
| Role        | `pkey-implementer`                                                                                |
| Plan mode   | no                                                                                                |
| Gates       | `migration`, `table-owners`                                                                       |
| Human input | none                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-08** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: §2.4: the birth date accepted from the gate record only; terms URLs, with privacy linked and not accepted; one `ALTER` per file. Acceptance (Q2): terms acceptance is recorded for every new account once `identity.platformTerms` is set; none is shown or recorded while it is unset.

## Goal

Profile v2: screen name, birth date, platform terms, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-08** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **IX-08**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- accounts.birthdate and `birthdate_source`, optional, imported from a connection's birthdate claim and overridable; apps never receive it, and age booleans (and any minimumAge) wait until a product gates content; 'Screen name' with per-source suggestions (`signin.register.*`, `portal.profile.*`); one finish API for both new-account paths (I/card/gate.ts state machine extended); Polaris Key terms and privacy accepted as `_platform` rows with a platform version setting; product terms URLs from the listing's eulaUrl and privacyUrl; PRIVACY.md birth-date minimisation.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-08**; DX consolidation F: Identity.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Apps never receive a birth date (test)
- [ ] Platform terms acceptance recorded for every new account
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-33 done`.
