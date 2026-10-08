# SP-33a One integration content generator on today's names, and pkey sdk add --expect

| Field       | Value                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration)                                             |
| Size        | 1.2–1.5 engineer-weeks                                                                                                                                |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md), [UK-14](UK-14-node-terminal.md)                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-41](ST-41-integration-page-overview-card.md), [SP-33b](SP-33b-integration-content-on-polaris-key-json.md) |
| Role        | `pkey-implementer`                                                                                                                                    |
| Plan mode   | no                                                                                                                                                    |
| Gates       | none beyond the green gate                                                                                                                            |
| Human input | none                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-60.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/SP-35.md`](../plans/SP-35.md) §12: canonical names; the goldens are in the removed-name scan.
- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 3: `renderUsage(feature, lang, lane)`, with `lane` = `kit` or `library`, and goldens for both lanes. SP-33a also writes the docs' generated blocks.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

One integration content generator on today's names, and pkey sdk add --expect, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **SDX-02**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- @polaris-key/manifest/integration built from today's pkey sdk renderer (packages/cli/src/sdkConfig.ts, already a rule-3 generated family) on the constructor names SDKs ship today: renderSdkSetup (install via renderFeedSetup, a kit-first start with a headless tab), renderUsage(feature, lang, ctx) for licensing, config, identity, update, packs, sync and commerce from a real product context, and sdkFit(platforms, repoSignals); registered in P0-42; consumers ST-41 and pkey sdk add <lang> --expect; delete sdkQuickStart.ts sdkInit and manifest.ts sdkSnippet/trustSnippet. renderFeedSetup and renderOutletBlock stay siblings. Absorbs UX-60.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-02**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One snippet generator for the console and the CLI (grep)
- [ ] React snippets carry trust pins
- [ ] Goldens for the TypeScript and Python lanes compile
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-33a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-33a done`.
