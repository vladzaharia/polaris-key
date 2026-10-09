# SP-32a polaris-key.json: plan, schema, fromConfig() and doctor() in Node, React and Python

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (DX consolidation C: Products, onboarding and Integration) |
| Size        | 1.2–1.6 engineer-weeks                                                                                    |
| Depends on  | [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-34](SP-34-client-core-takes-neutral-typescript.md)   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-32b](SP-32b-polaris-key-json-fromconfig-doctor-in.md)         |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                      |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-32a.md` first; no code before a human approves it               |
| Gates       | `plan-mode`, `all-sdks`                                                                                   |
| Human input | plan approval (`plans/SP-32a.md`)                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **SDX-01** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/SP-35.md`](../plans/SP-35.md) §12: its schema properties, except `$schema` and `configVersion`, equal the `configFile` rows of `api.json` (test).

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Adds `backend.origins` to the `polaris-key.json` schema and to `fromConfig()`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Kit adapters accept the config object; `doctor()` runs on a document verify failure and reports an origin mismatch; the outlet and release pins in `polaris-key.json`; Python's version from `importlib.metadata`.

## Goal

polaris-key.json: plan, schema, fromConfig() and doctor() in Node, React and Python, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **SDX-01** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §4.1, §4.2, §4.3, for **SDX-01**.
- [`audits/sdk-uikits-dx.md`](../../../2026-10-07-dx-consolidation/audits/sdk-uikits-dx.md), for file and line evidence.

## Scope

**In:**

- Plan (all-SDK public API) and the TypeScript and Python slice: JSON Schema shared-manifest/schemas/v1/sdk-config.schema.json with the flat names SDKs ship (productSlug, baseUrl, pinnedKeys, pinnedReleaseKeys, expectedServices, plus $schema and configVersion); fixtures conformance/sdk-config/\* replayed by every SDK's loader test; fromConfig() then boot() in Node, React (config prop) and Python; create(options) stays the low-level call; the app version auto-detected where the platform has it; client.doctor() (core.doctor parity id) with console deep links; THREAT-MODEL row. No wire change. Third in the serial SDK lane.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **SDX-01**; DX consolidation C: Products, onboarding and Integration.
- Plan mode (client api): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/SP-32a.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

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

- **Builds or backs 2 mockup item(s):** `sdk.client-doctor`, `sdk.start-call`.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Acceptance criteria

- [ ] Node, React and Python load the shared fixture
- [ ] No remote config fetch (test)
- [ ] Plan approved (all-SDK public API)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `reference/api-names`; every quickstart regenerated; snippets included from `examples/` (the SDK docs-snippets targets retire); `build/sdks/*` reference-only.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set SP-32a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-32a done`.
