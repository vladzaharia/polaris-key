# SP-35 SDK API registry (api.json) and 0.9 normalisation

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md), [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [LX-19](LX-19-sdks-licensing.md), [LX-20](LX-20-commerce-clients.md), [SP-32a](SP-32a-polaris-key-json-plan-schema-fromconfig.md), [SP-33b](SP-33b-integration-content-on-polaris-key-json.md), [SP-34](SP-34-client-core-takes-neutral-typescript.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md), [DOC-06c](DOC-06c-kits-get-help.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/SP-35.md`](../plans/SP-35.md) (2026-10-08) §7 slice 1; SP-35b takes Godot, Swift and Kotlin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gates       | `plan-mode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-04** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## Approved plan (2026-10-08)

[`plans/SP-35.md`](../plans/SP-35.md) is the scope: its §7 slice 1. It wins over the text below where they differ.

- The registry, the generator and all six surface files, the lint, the enums and `reference/api-names.mdx`; Appendix A's renames in Node, React and Python, with every consumer moved in the same change.
- Removal, not deprecation (D6): a renamed name becomes a `removed` row, with no alias and no window. Kotlin is not flattened (D4).
- Swift, Kotlin and Godot stay `planned: SP-35b` at their current spellings; [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) renames them.
- [`plans/U-01b.md`](../plans/U-01b.md) §11: record D8's names in `api.json`, including `setting(key).sync()`.

## Goal

SDK API registry (api.json) and 0.9 normalisation, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-04** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.2, §4.1, §4.2, §4.3, for **SDX-04**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.
- [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md), for file and line evidence.

## Scope

**In:**

- conformance/parity/api.json: canonical concept -> per-SDK symbol with `removed` rows (no aliases); the canonical name is the one most SDKs ship (config.get, getSecret, mintToken, set, clear, clearAll, setting(key) with visibility and sync, onConfigChange; entitlements.has/value/grants with quantity reserved; identity.signIn/subject/signOut; one events stream with a cloudSync kind; collection() reserved); renames only where SDKs disagree (React expectedServices, Godot product_slug and pinned_keys, Python pinned_keys; Kotlin is not flattened); HA-13 and HA-14's presentation readers land first and are recorded; React's `auth` row for SP-40's removal of cookie mode; generated per-SDK surface tests; reference/api-names.mdx; samples, docs and console snippets regenerated. Two slices: TypeScript and Python, then Swift, Kotlin and Godot. Heads the serial SDK lane (SP-35 -> SP-34 -> SP-32a -> SP-32b -> SP-39); lands before I-10a/b, LX-19, U-06 and CM-15.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track J (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-04**; DX consolidation J: SDK and UI-kit consolidation.
- Plan mode (client api): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement `plans/SP-35.md` §7 slice 1; run the green gate; hand off.

## Acceptance criteria

- [ ] Each SDK's surface test asserts every canonical symbol
- [ ] No new SDK verb outside api.json (lint)
- [ ] Every command in `plans/SP-35.md` §13 above the SP-35b line passes
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

`plans/SP-35.md` §13 (the lines above `# SP-35b`), then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-35 done`.
