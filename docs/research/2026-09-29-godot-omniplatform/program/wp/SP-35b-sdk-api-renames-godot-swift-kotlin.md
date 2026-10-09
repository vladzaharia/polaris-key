# SP-35b SDK API 0.9 renames in Godot, Swift and Kotlin

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation J: SDK and UI-kit consolidation)                                                                                                                                                                                                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                       |
| Depends on  | [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [HA-14](HA-14-godot-presentation.md)                                                                                                                                                                                                                                                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [U-23](U-23-collections-sdk-swift-kotlin-godot.md), [LX-19](LX-19-sdks-licensing.md), [LX-20](LX-20-commerce-clients.md), [SP-32b](SP-32b-polaris-key-json-fromconfig-doctor-in.md), [SP-33b](SP-33b-integration-content-on-polaris-key-json.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                       |
| Plan mode   | yes: executes the approved [`plans/SP-35.md`](../plans/SP-35.md) (2026-10-08) §7 slice 2 and Appendix A                                                                                                                                                                                                                                                                                                                    |
| Gates       | `plan-mode`, `all-sdks`, `drift-gate`, `docs-generated`, `ui-snapshots`, `ci:macos`, `ci:android`                                                                                                                                                                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                  |

## Goal

Godot, Swift and Kotlin ship the canonical names of `conformance/parity/api.json`, every `planned: SP-35b` entry is flipped, and every removed name has its `removed` row. Done when every acceptance criterion holds and the green gate passes.

## Why

SP-35 fixed the registry and renamed Node, React and Python. Each SDK breaks once, in the v0.9.x release that carries its package (SP-35 §10), so these three follow in one package, Godot first.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`plans/SP-35.md`](../plans/SP-35.md) §0 (D1–D10), §7 row 2, §9, §13 and Appendix A.

## Scope

**In** (`plans/SP-35.md` §7 row 2):

- Appendix A's renames in Godot, Swift and Kotlin: `config.get`, `getConfigSource`, `getSecret`, `activateWithKey`, Godot `product_slug` and `pinned_keys`, the Godot `event(kind, data)` signal, `entitlements.*` and the setting handle's `visibility` (D9). Swift's `changes` and Kotlin's `licenseChanges` are removed; Kotlin's `:ui` reads the events stream instead.
- D7 in Godot: `configure` refuses `product` and `pinned_trust_keys` with `invalid-options` naming the replacements; the setup dock fills the new fields from an old `.tres` so Save rewrites it.
- Kotlin's `PolarisKeyFutures` mirrors the renames.
- The dynamic Godot reads moved by hand: `core/build_stamp.gd:170`, `editor/setup_dock.gd:114-118`, `editor/setup_check.gd:166-168`.
- Consumers in the same change: `PolarisKeyUI`, Kotlin `:ui`, Godot `ui/`, `sdkConfig.ts:441-532`, `sdkQuickStart.ts:280-282`, READMEs and snippets (each with the 0.9 names, the minimum SDK version and a link to `/docs/reference/api-names/`).

**Out** (and where it belongs instead):

- The registry, generator, lint and the Node, React and Python renames (→ SP-35); new verbs (→ LX-19, LX-20, U-07, U-21, U-23).

## Design notes

- Removal, not deprecation (D6): no alias, no `@deprecated` forwarder, no window.
- Not renamed: the build stamp's `product` key (`export_plugin.gd:200`) and `PKeyCore.product`.
- Can run beside SP-34; the SDKs do not overlap.

## Steps

1. Verify Appendix A's file and line references against the code and record corrections here.
2. Godot, then Swift, then Kotlin; flip each `planned: SP-35b` entry as its SDK lands.
3. Run the green gate; hand off.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Acceptance criteria

- [ ] No `planned: SP-35b` entry remains in `api.json`; every removed name has its `removed` row.
- [ ] The surface tests pass in all three SDKs and assert the removed names are absent.
- [ ] D7: a fixture `.tres` with `product` and `pinned_trust_keys` fails `configure` naming both replacements; the dock rewrites it on Save.
- [ ] Kotlin's `:ui` gate still updates on a licence sync after leaving `licenseChanges`.
- [ ] `pnpm ui:report` shows no baseline change.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

`plans/SP-35.md` §13, including the lines under `# SP-35b`, then the full green gate in `AGENTS.md`.

## Hand-off

SP-32b, SP-33b, I-10b, U-07, U-21, U-23, LX-19 and LX-20 build on these names. The role agent sets `--set SP-35b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-35b done`.
