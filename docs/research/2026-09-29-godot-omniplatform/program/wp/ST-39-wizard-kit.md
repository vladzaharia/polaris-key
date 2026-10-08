# ST-39 Wizard kit

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                                                                                                                                                                                       |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [I-31](I-31-platform-connections-setup-wizards.md), [U-32](U-32-catalog-templates-cloud-sync-page-minted.md), [A-23](A-23-channel-setup-wizards-setup-runner.md), [A-32](A-32-github-write-path-publish-from-ci.md), [ST-40](ST-40-integration-facts-sdk-sightings.md), [ST-41](ST-41-integration-page-overview-card.md), [ST-43](ST-43-new-product-wizard.md), [LX-29](LX-29-new-license-wizard.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-50, UX-51, UX-80.

## Goal

Wizard kit, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.3, for **OB-03**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- ui/wizard page and drawer hosts, Stepper, ChoiceStep, FormStep, SnippetStep, WaitingFor, DoneStep, PrereqList, AutoList (DeepLink, RepoChange and Confirm steps are added by their first consumer); explicit choices (Integration hidden, 'not using this channel', runner consent, skipped steps) are one operator-owned product setting, core.setup ({integrationHidden:{at,by}, notUsing:[], runnerConsent, skipped:[]}, no manifest path), written through writeSetting() so audit, history, Revert and RBAC come with the registry; step completion is never stored; flow-lint fixtures; StorefrontsPage's flow migrated as the proof; ui/Stepper.tsx's old API deleted. A console 'now' item, after the lead's window. Absorbs UX-50, UX-51 (trimmed) and UX-80.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-03**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No wizard outside ui/wizard (lint)
- [ ] core.setup writes are audited through writeSetting (no new table or route)
- [ ] One existing flow migrated
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-39 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-39 done`.
