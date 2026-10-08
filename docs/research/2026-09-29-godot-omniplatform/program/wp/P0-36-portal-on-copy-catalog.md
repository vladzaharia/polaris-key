# P0-36 Portal on the copy catalog

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                    |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                   |
| Depends on  | [UK-14](UK-14-node-terminal.md), [ST-36](ST-36-owner-polish-portal-fixes-simple-product.md)                                                              |
| Unblocks    | [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [P0-51](P0-51-1-0-readiness-review.md), [PX-12](PX-12-login-card-v2.md), [LX-15](LX-15-portal-licensing.md) |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                       |
| Gates       | `portal-e2e`, `console-csp-parity`                                                                                                                       |
| Human input | none                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQF-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Portal on the copy catalog, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQF-06** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQF-06**.
- [`audits/cq-frontend.md`](../../../2026-10-07-dx-consolidation/audits/cq-frontend.md), for file and line evidence.

## Scope

**In:**

- lib/copy.ts t() over @polaris-key/brand/kit-copy with an ICU-subset formatter; replace the 41 verbatim strings, the signin.\* placeholders and the 24 refusal-code wordings; origin word 'Automatic grant' from the catalog; ui-qa portal board over e2e/portalStates.ts. Rebases after UK-14's kit-copy edits.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQF-06**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No verbatim customer-facing string in the portal (lint)
- [ ] 'Automatic grant' comes from the catalog in sentence case
- [ ] ST-36's e2e assertions (e2e/portal.e2e.test.ts) and PORTAL.md updated to 'Automatic grant'
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-36 done`.
