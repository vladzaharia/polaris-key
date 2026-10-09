# UK-03 ui-core: the one JS headless layer (absorbs UK-14's models)

| Field       | Value                                                                                                                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                  |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-14](UK-14-node-terminal.md)                                                                                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-19](LX-19-sdks-licensing.md), [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-06](UK-06-electron-kit.md), [UK-17](UK-17-vue-kit.md), [UK-18](UK-18-svelte-kit.md), [UK-19](UK-19-angular-kit.md), [UK-20](UK-20-react-native-kit.md), [UK-42](UK-42-activation-holders-web.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                            |
| Gates       | the UI fixture runner in `pnpm test`; `pnpm typecheck`                                                                                                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                     |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package: **the DeviceLimit view model** names its action `replaceDevice`, and its
default target in layer 1 is `manageUrl`. There is no in-app device list until I-13's `choose`
adds a native **LicenseChoice** view model.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `LicenseChoice` view model with `ReplaceDevice` inside; DeviceLimit titled **Replace a device** with the "Replace <device>?" confirm and **Replace and continue** (SIGN-IN.md §3.7, D-08); row anatomy with `access` (O-11).

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- Add one `SignInModel`: the state machine of the form (methods → handoff | code → finishing → choose ↔ replace | key → done, plus error, expired, cancelled), driven by the SDK primitives and the grant, with `presentation` and `replace` as inputs and the step models (`LicenseChoiceModel`, `ReplaceDeviceModel`, `ActivateModel`) inside it.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> ui-core is the only JS headless layer: absorbs UK-14's cli/models.ts and @polaris-key/react/core state; takes boot and activation view logic from client-core; a SignInModel hook point I-10a fills.

- Title: was "`@polaris-key/ui-core`: framework-neutral view models for every §4 component over `client-core`, error → copy keys, theme and `ProductIdentity` resolution with the presentation seam, the fixture runner".
- Depends on: added UK-14.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: adds the JS runner of §5 and `packages/ui-core/test` to the React and Node manifests' `testRoots`; runs the `signIn` family through `SignInModel`; moves UK-14's `models.ts` onto ui-core with byte-identical goldens; the `test/cli/scenarios.ts` stand-ins the matrix covers retire.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Also serves a Node main process with a plain renderer (snapshot, subscribe, `{key, args}` views).

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL4, DL6, DL7, DL9, DL13, DL14 and DL16 as data; the rest render in UK-04 and UK-05.
- **In this kit:** The language as data, so every JS kit renders the same decision. Each view model names, per state, its one primary action, the refusal tone (`neutral` for the DL6 states), the slot each error belongs to and the initial-focus target. The link policy lives here: https-only validation, the switch to expired at 0:00, and whether the surface may show a QR. The theme resolver runs `resolveAccent` against the host's surfaces under `native` (the Compose round's `surfaces` parameter, ported), and the 250–300 ms loading delay is a model timer.
- **Minimum check:** Fixture tests assert, per state, the primary id, the refusal tone, the error slot, the initial-focus id and the link verdict. No screens, so no §7.1 rows.
- **Acceptance:** the fixture assertions above pass; the UX review happens on the screens UK-04 and UK-05 render from these models.

## Goal

Every JS kit renders from one state machine per component: `@polaris-key/ui-core` passes every UI fixture, resolves the theme and product identity, and has no DOM or framework dependency.

## Why

Layer (c) for the JS kits; elements, React, Vue, Svelte, Angular and React Native all sit on it (§5.1). It grows from `@polaris-key/react/core`. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.2, §1.3, §3, §4.1, §5.1, §5.2
- `packages/sdk-react/src/core/`, `packages/client-core`
- HA-11 brief and, once written, `plans/HA-11.md` (the presentation shape)

## Scope

**In:**

- View models and actions for every §4.1 component; error → copy key mapping over `core.copy`.
- Theme resolution (preset, accent via `resolveAccent`, scheme, density, motion, platform).
- `ProductIdentity` resolver: integrator → presentation source (an injected `PresentationSource` interface, implemented by the SDK once HA-13 lands) → bundle → `deriveAccent` → ink.
- The fixture runner over UK-02b's fixtures; a UI-thread delivery hook.

**Out** (and where it belongs instead):

- Any rendering (→ UK-04, UK-05 and the should-tier JS kits).
- Fetching or verifying presentation (→ HA-13).

## Design notes

- The presentation seam is the only path for presentation data in JS kits (owner decision); when HA-13 ships `client.presentation()` the SDK supplies the source and no kit changes.
- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).

## Presentation seam ([`plans/HA-11.md`](../plans/HA-11.md), approved 2026-10-06)

- **Do not define a seam.** The kit's `ProductIdentity` resolver takes the TypeScript `PresentationSource` from `@polaris-key/client-core/presentation` (written by HA-12).
- **Bidi-isolate presentation text** ([`plans/HA-12.md`](../plans/HA-12.md) Q5). The SDK keeps bidi controls in `PresentationSource` `name` and `developerName` (only C0 and C1 are dropped), so the kit renders both in an isolated run: a `<bdi>` element or `dir="auto"` in the renderers.
- **Before that lands.** If the SDK type has not landed when this package starts, declare a
  structurally identical local type, `current()`, `icon(px, scale)` and change notification, and
  replace it with the SDK's type when it lands.
- **Fake sources.** Tests build fake sources from that type.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] Every UK-02b fixture passes.
- [ ] A test with a fake `PresentationSource` resolves the product accent (and `accentDark` in dark) with no integrator input; with no source it falls through to the bundle and then the derived accent.
- [ ] No DOM, React or Lit import in the package (a test asserts it).
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/ui-core test
mise exec node@22 -- pnpm typecheck
```

## Hand-off

UK-04, UK-05, UK-17–UK-20 and UK-22 build on its models and resolver; HA-13 implements `PresentationSource` for client-core.

The role agent sets `--set UK-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-03 done`.
