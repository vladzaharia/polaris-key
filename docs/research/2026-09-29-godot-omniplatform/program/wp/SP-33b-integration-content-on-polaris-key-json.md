# SP-33b Integration content on polaris-key.json in every SDK, the docs and the Godot dock

| Field       | Value                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration)                                                                                                                    |
| Size        | 1–1.2 engineer-weeks                                                                                                                                                                                                         |
| Depends on  | [SP-33a](SP-33a-one-integration-content-generator-on.md), [SP-32b](SP-32b-polaris-key-json-fromconfig-doctor-in.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-36](SP-36-examples-in-one-tree-built-in-ci.md), [SP-37](SP-37-developer-docs-reshape.md), [SP-38](SP-38-conditional-token-provisioning-sdk.md)                                   |
| Role        | `pkey-implementer`                                                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                                                           |
| Gates       | `all-sdks`                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-02b** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

Integration content on polaris-key.json in every SDK, the docs and the Godot dock, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-02b** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, for **SDX-02b**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- SP-33a's generator moves to polaris-key.json, fromConfig() and api.json names; goldens under test/fixtures/integration/<lang>/ compiled in all six SDK lanes; consumers add the Godot dock and the docs site (gen:integration writes build/quickstart/\*.md and per-SDK tabs, a GENERATED family with --check, rule 3); delete the six sdkConfig.ts renderers' legacy mode and the legacy pkey sdk mode. ST-41's page needs no change.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-02b**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Goldens compile in all six SDK lanes
- [ ] The docs site renders the same output
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-33b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-33b done`.
