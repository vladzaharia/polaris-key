# SP-35 SDK API registry (api.json) and 0.9 normalisation

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Depends on  | [P0-42](P0-42-generator-registry-pnpm-gen.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md), [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [LX-19](LX-19-sdks-licensing.md), [LX-20](LX-20-commerce-clients.md), [SP-32a](SP-32a-polaris-key-json-plan-schema-fromconfig.md), [SP-33b](SP-33b-integration-content-on-polaris-key-json.md), [SP-34](SP-34-client-core-takes-neutral-typescript.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md), [SP-42](SP-42-test-doubles-on-the-real-client-in-every-sdk.md), [SP-43](SP-43-sync-outcomes-reasons-same-second-documents.md), [SP-44](SP-44-updates-for-package-manager-installs.md), [SP-49](SP-49-python-typed-surface-for-0-9.md), [DOC-06c](DOC-06c-kits-get-help.md), [AX-10](AX-10-sdk-skills-should-tier.md), [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md), [AX-22](AX-22-doc-comments-on-every-exported-sdk-symbol.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | yes: executes the approved [`plans/SP-35.md`](../plans/SP-35.md) (2026-10-08) §7 slice 1; SP-35b takes Godot, Swift and Kotlin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gates       | `plan-mode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-04** in [Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## Approved plan (2026-10-08)

[`plans/SP-35.md`](../plans/SP-35.md) is the scope: its §7 slice 1. It wins over the text below where they differ.

- The registry, the generator and all six surface files, the lint, the enums and `reference/api-names.mdx`; Appendix A's renames in Node, React and Python, with every consumer moved in the same change.
- Removal, not deprecation (D6): a renamed name becomes a `removed` row, with no alias and no window. Kotlin is not flattened (D4).
- Swift, Kotlin and Godot stay `planned: SP-35b` at their current spellings; [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md) renames them.
- [`plans/U-01b.md`](../plans/U-01b.md) §11: record D8's names in `api.json`, including `setting(key).sync()`.

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Adds `api.json` rows with `layer: server` or `cli` for every name in the plan's §5–§7, and the `requireLicense` family across servers and CLIs.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Widened rows (result shapes, units, semantics with corpus ids, errors, event triggers, `layer`); C-25 restated (the most-shipped spelling is not canonical for `config.get`, `license.activate`, `entitlements.*` and `identity.signIn`); the `entitlement` event kind; gated `entitlements.*`; `boot()` enrolment; Godot's `get_value` exception; option units; the casing rule; root shortcuts; Swift `documentExpiresAt`; `init(options:)` not public; registry rows before the pass. Re-estimate once the widened rows are counted.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- Each renamed `api.json` row records `replaces` (feeds DOC-12a's upgrade table, `upgrading-polaris-key` and `check_sdk_names`).

## Corrections (2026-10-23)

The code at `integ/next-stage` @0108e1bbc is the fact; the approved plan's line references are from `e4a527fee`. Slice plan: `_lead/plans/SP-35-slices.md` (SP-35.1 to .22).

- **A1. React's Provider has already moved** (kit cutover): `config.expectedServices`, and a top-level `expectServices` prop is refused with `invalid-options` (`Provider.tsx:54,78,115-118`). Left: the three adapters' `expectServices` option (browser in ui-core `browserAdapter.ts:389`, desktop `desktopAdapter.ts:158`, local `localAdapter.ts:126`; `ui-core/src/browser/driver.ts:134-137` maps it).
- **A2. React has more removed-name surface:** `usePolarisKey()` (`@deprecated`) still returns `getConfig` and `isEntitled` (`hooks.ts:115,121,156,160`); `useConfigSetting` has no `visibility` (`hooks.ts:298-341`). `PolarisAdapter.getConfig` and `isEntitled` stay (adapter root, `ignore`).
- **A3. Node line drift:** `ConfigClient.getConfig` :137, `getConfigSource` :143, `setting()` :264-276, `ConfigSetting` :64-74; facade `client.getConfig` `client.ts:672-673`; licence `isEntitled` :134, `entitlementValue` :142, `getEntitlements` :173; event kinds `core/events.ts:16-22` (no `entitlement`). Consumers: `cli/gate.ts:237`, `cli/commands.ts:242` (the `/cli` command function stays), `local/index.ts:46`, `commerce/client.ts:109`.
- **A4. Python line drift:** `config/client.py` `get_config` :89, `get_config_source` :95, `setting` :180, `on_change` :185, `ConfigSetting` :255-284; `client.py` `trust` :146, `on_config_change` :599-601, `get_config` :763-764; `aio.py` forwarded names :54-55; licence `is_entitled` :135, `entitlement_value` :149, `get_entitlements` :181. Consumers: `ui/terminal/flows.py:710`, `server_client.py:17,110`, `local/__init__.py:46`, `__init__.py:7,9`, `cli/gate.py:161`, `examples/python-cli/mytool.py`, `examples/python-renpy/polaris_key.rpy`, `examples/ui/qt/tidewater_qt.py`. `ServerClient(trust=)` (`server_client.py:100`) is unlisted in the plan (L8).
- **A5. The snippet generators moved (SP-33a).** SP-35 edits no file in `packages/admin`. The live emitter of old names is `packages/shared-manifest/src/integration/usage.ts` (Node :170, :182, :268, :270; Python :636, :647, :650, :702, :717; :356 `v.isEntitled` stays), and `integration/sdkConfig.ts` (Python `"trust"` :185, Godot `pinned_trust_keys` :288). Goldens: `shared-manifest/test/fixtures/integration/**` (`pnpm gen integration`); `pnpm gen action-bundle` after `pnpm build`.
- **A6. The parity gate is a `pnpm gen` family.** api-check is rule 8 of `tools/parity-check.ts` (family `parity`), whose `inputs` now include the scanned SDK sources. The AGENTS.md rule-3 table is generated (`pnpm gen registry-docs`).
- **A7. Other anchors:** `gen-reference.mjs` `EMITTERS` :1029-1038; Godot `runner.gd` `ci` list :32; Kotlin `sdk/src/test/kotlin/polaris/generated/` exists. `enums.json` lacked `settingVisibility` and `eventKind` (added in SP-35.1; the enum value pattern now allows camelCase).
- **A8. Corpus names the scan must not touch:** `gate-matrix.json` `expect.isEntitled` (`tools/corpus/gate.ts:855`); comments at `tools/corpus/gate.ts:836` and `client-core/src/config.ts:33` (plan-mode files; out of the scan).
- **A9. The wire and docs use `"trust"`** (`reference/protocol/discovery.md:44`, `bundles.md:35`): the Python `trust` row's `scan.files` is limited to `*.py`, `*.rpy` and `python` fences.
- **A10. The server layer keeps the old entitlement spellings on purpose** (`@polaris-key/server` `verifyLicenseDocument.ts:41-43,84-85`, `context.ts:62`, `core.ts:516`; `polaris_key/server/_verdict.py:182,335`): `layer: "server"` rows (L4).
- **A11. The brief widened scope after approval** (framework drop-ins, SDK usability, LLM audit, docs plan): `layer`, `returns`, `unit`, `errors`, `triggers` on rows (L2); `replaces` is the `removed` rows (L3). No upgrade-table generator exists yet (DOC-12a is todo).
- **A12. Docs and READMEs naming removed names:** `build/sdks/{python,react}/your-own-ui.md`, `features/licensing/server-{node,python}` (:349, :292), `packages/sdk-node/README.md`, `sdks/python/README.md`, `.claude/skills/adding-a-catalog-entry`, `examples/ui/terminal-node`. The Swift, Kotlin and Godot READMEs are SP-35b's.

**Lead decisions (accepted 2026-10-23, all as recommended):** L1 Node, React and Python rows start `planned: "SP-35"` at today's spelling and each rename slice flips its own; L2 optional `layer` on every row, the other widened fields on Appendix A rows only; L3 no new field, `removed` rows are the `replaces` data (DOC-12a builds the upgrade table; `api-check --notes` feeds release notes); L4 server and CLI layers kept (`layer` rows, `ignore` for rule 1); L5 `expectedServices: readonly ServiceSlug[]` on the three adapters; L6 remove `usePolarisKey()`'s `getConfig` and `isEntitled`, keep the hook; L7 `useConfigSetting` keeps `fallback` and gains `visibility`; L8 Python `ServerClient(trust=)` becomes `pinned_keys`; L9 `client.entitlements` is a thin view over the licence gate, no root shortcut; L10 api-check runs as rule 8 of `parity-check.ts`; L11 a row's `sdks` lists every SDK that ships it (`{}` = generated spelling); L12 Swift, Kotlin and Godot inventory stays in SP-35 (.11 to .13).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 2 mockup item(s):** `sdk.client-doctor`, `sdk.start-call`.

## Acceptance criteria

- [x] Each SDK's surface test asserts every canonical symbol
- [x] No new SDK verb outside api.json (lint)
- [x] Every command in `plans/SP-35.md` §13 above the SP-35b line passes
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only.
- [x] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7). _Met per slice-plan L3: no new `replaces` field. The `removed` rows in `conformance/parity/api.json` are the data; `reference/api-names`'s "Removed in 0.9" lists them and `pnpm exec tsx tools/api-check.ts --notes SP-35` renders the release notes (23 rows). The changelog page is still a stub and DOC-12a builds the upgrade table from these rows._
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

`plans/SP-35.md` §13 (the lines above `# SP-35b`), then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-35 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-35 done`.
