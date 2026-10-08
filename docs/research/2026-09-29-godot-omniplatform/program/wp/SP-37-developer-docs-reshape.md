# SP-37 Developer docs reshape

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration) |
| Size        | 1–1.5 engineer-weeks                                                                                      |
| Depends on  | [SP-33b](SP-33b-integration-content-on-polaris-key-json.md)                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | `docs-links`                                                                                              |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-06** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

Developer docs reshape, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-06** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **SDX-06**.
- [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md), for file and line evidence.

## Scope

**In:**

- One 'Your first product' path (merging start/quickstart.md, build/quickstart/index.md and build/onboarding.md) mirroring the console wizard; build/sdks/\* reference-only (README: install, golden start, link); a generated per-version developer changelog; no programme ids in READMEs and developer pages (lint); Tidewater as the one example; uiKits.ts and build/ui/frameworks trimmed to the must tier plus recipes; docsLinks and nav.ts updated (slug-manifest gate).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-06**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One start path
- [ ] Programme-id lint passes on developer pages
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm --filter @polaris-key/docs build
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-37 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-37 done`.
