# SP-33b Integration content on polaris-key.json in every SDK, the docs and the Godot dock

| Field       | Value                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration)                                                                                                                                                                                     |
| Size        | 1–1.2 engineer-weeks                                                                                                                                                                                                                                                                          |
| Depends on  | [SP-33a](SP-33a-one-integration-content-generator-on.md), [SP-32b](SP-32b-polaris-key-json-fromconfig-doctor-in.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md), [SP-45a](SP-45a-developer-docs-two-lanes-per-sdk-on-today-s.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-36](SP-36-examples-in-one-tree-built-in-ci.md), [SP-37](SP-37-developer-docs-reshape.md), [SP-38](SP-38-conditional-token-provisioning-sdk.md)                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                            |
| Plan mode   | no                                                                                                                                                                                                                                                                                            |
| Gates       | `all-sdks`                                                                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                     |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-02b** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/SP-35.md`](../plans/SP-35.md) §12: canonical names; the goldens are in the removed-name scan.
- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 3: `renderUsage(feature, lang, lane)`, with `lane` = `kit` or `library`, and goldens for both lanes.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Writes both lanes' snippets into SP-45a's page skeleton.

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `products.integration`, `sdk.start-call`, `sdk.docs-first-product`.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Acceptance criteria

- [ ] Goldens compile in all six SDK lanes
- [ ] The docs site renders the same output
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-33b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-33b done`.
