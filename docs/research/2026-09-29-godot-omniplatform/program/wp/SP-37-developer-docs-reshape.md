# SP-37 Developer docs reshape

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration)                                           |
| Size        | 1–1.5 engineer-weeks                                                                                                                                |
| Depends on  | [SP-33b](SP-33b-integration-content-on-polaris-key-json.md), [ST-41](ST-41-integration-page-overview-card.md), [ST-43](ST-43-new-product-wizard.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                  |
| Plan mode   | no                                                                                                                                                  |
| Gates       | `docs-links`                                                                                                                                        |
| Human input | none                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-06** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 5: it depends on ST-41 and ST-43 as well as SP-33b, because "Your first product" mirrors the wizard. Its final path gets the fresh-reader run (§6.2). The developer changelog generator is DOC-12a's.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- The one start path forks into two lanes; the `your-own-ui` pages survive the reference trim.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The SDK READMEs (`packages/sdk-node`, `packages/sdk-react`, `sdks/python`, `sdks/swift`, `sdks/kotlin`, `sdks/kotlin/ui`, `sdks/godot`) follow the plan's §3.1 published-package template, which is this package's "reference-only (install, golden start, link)": history out, absolute `https://key.plrs.im/docs/…/` links, a For agents section, under 400 lines. `sdks/kotlin/ui` is added to the list.
- They keep rendering as the SDK pages. `check:links` resolves their absolute docs links against the slug manifest, and `AGENTS.md`'s link rule names this one exception (published READMEs).
- The plan moved these rows here from AX-01 (review B7).

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
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only.
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
