# I-34 Granular consent and Connected apps

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                        |
| Size        | 0.8–1.2 engineer-weeks                                                                                                   |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-11](I-11-portal-library.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-31](PX-31-account-composition-v3.md)                                         |
| Role        | `pkey-implementer`                                                                                                       |
| Plan mode   | no                                                                                                                       |
| Gates       | none beyond the green gate                                                                                               |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-09** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the §12.7.3 text; `scopeHash` unchanged.

## Goal

Granular consent and Connected apps, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-09** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, for **IX-09**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- identity.claims {required, optional}; AppConsentView items gain required and granted; Continue posts the granted subset and scope_hash covers it; Cloud Sync optional unless the app requires it (declining leaves sync off for that app); portal Account -> Connected apps (what each app gets, Change what <App> gets, Disconnect through I-11's revocation hook). Device wire unchanged.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-09**; DX consolidation F: Identity.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Connected apps sits third in the Account nav and replaces the 'Connected products' card. 'Gets' chips encode state by icon and word (a check with the claim for granted; a struck glyph with 'Not your <claim>' for declined), never colour alone. The footnote 'Disconnecting signs the app out on every device within an hour' must match the real token lifetimes, else word it as what happens: 'signs <App> out; it asks you to sign in again'. 'Change what <App> gets' reopens the consent toggles of PX-14. Decide whether 'Access tokens' is separate from Packages before building the nav. (portal-12)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 7 mockup item(s):** `identity.app-sign-in-changes`, `identity.app-sign-in`, `identity.connected-apps`, `identity.consent`, `identity.disconnect`, `portal.account`, `hosted:consent`.

## Acceptance criteria

- [ ] A declined optional scope is never delivered (test)
- [ ] Disconnect signs the app out
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-34 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-34 done`.
