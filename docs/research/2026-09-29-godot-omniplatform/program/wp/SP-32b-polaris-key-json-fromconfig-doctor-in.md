# SP-32b polaris-key.json, fromConfig() and doctor() in Swift, Kotlin and Godot

| Field       | Value                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration)                                                                                    |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                         |
| Depends on  | [SP-32a](SP-32a-polaris-key-json-plan-schema-fromconfig.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md)                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-33b](SP-33b-integration-content-on-polaris-key-json.md), [SP-36](SP-36-examples-in-one-tree-built-in-ci.md), [SP-39](SP-39-one-copy-pipeline.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                           |
| Gates       | `all-sdks`                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-01b** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## Goal

polaris-key.json, fromConfig() and doctor() in Swift, Kotlin and Godot, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-01b** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.1, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: the [decision record](../../../2026-10-07-dx-consolidation/integration.md) (no audit names **SDX-01b**).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.1, §4.2, for **SDX-01b**.

## Scope

**In:**

- Executes SP-32a's approved plan for Swift (fromBundle alias), Kotlin (PolarisKeyAndroid.client(context), desktop, JVM) and Godot (res://polaris-key.json with an export filter): fromConfig() then boot(), auto-version, doctor(); legacy plist, .tres and typed-module fallbacks.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-01b**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] All six SDKs load the same fixture
- [ ] Legacy configs still load (test per SDK)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-32b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-32b done`.
