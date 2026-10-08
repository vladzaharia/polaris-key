# LX-36 Access policy license.access (absorbs PS-09)

| Field       | Value                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                                                                                                                     |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                 |
| Depends on  | [LX-35](LX-35-add-on-definitions-grantaddon.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md), [D-02](D-02-diceroll-after-p1.md), [LX-16](LX-16-licensing-contract.md), [PS-12](PS-12-discover-visibility-one-setting.md), [LX-38](LX-38-account-keyed-automatic-licences.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                   |
| Gates       | `threat-model`, `rule-9`                                                                                                                                                                                                                                                                                                             |
| Human input | none                                                                                                                                                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-36** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.
- Absorbs PS-09: An email-domain rule is one branch of license.access; autoIssue.emailDomains is never created.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: `license.access` rules use §2.4's `when` object verbatim.
- [`plans/I-27.md`](../plans/I-27.md) §12: `SignInFacts`; the approval's policy half and its job (`edge-mint-approval-access`).
- [`plans/U-01b.md`](../plans/U-01b.md) §11: wire the Anonymous devices tier into `syncAccess`'s quota.

## Goal

Access policy license.access (absorbs PS-09), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-36** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.4, for **LX-36**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- Setting license.access and manifest licensing.access: Nobody | Everyone -> a tier | rules matching an issuer-bound group, a verified email domain or a claim -> tier:<id> | addon:<id>; an Anonymous devices tier (anonymous entry's only home). No upgradeOnSignIn knob: automatic licences (origin oidc) re-run accessFor() on every sign-in, upgrade only; licences issued by hand or by purchase are never touched. One pure accessFor() used by sign-in, the card, Discover, the storefront persona preview and edge-mint approval; RuleEditor, match preview and ClaimMatcher shared with ST-32's console.access. Migration through a P0-49 job from license.autoIssue, the groupRoleMap tier half (warning for its unread role), syncTierOnSignIn, storefront.polarisKey.groupLabels and provisioning entitlement hooks, converting LX-08's grt*oidc*<licence> grants into add-on grants with addon_id; PS-09's email domains become a rule; THREAT-MODEL rows (group injection, unverified domains). The editor lives on P2-10's product Access page.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-36**; DX consolidation E: Licensing model.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] P0-49 report for djdl and polaris-key shows identical outcomes, provisioned keys included
- [ ] accessFor() is the only evaluator (grep test)
- [ ] Unverified emails never match a domain rule (test)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-36 done`.
