# UK-03 `@polaris-key/ui-core`: framework-neutral view models for every §4 component over `client-core`, error → copy keys, theme and `ProductIdentity` resolution with the presentation seam, the fixture runner

| Field       | Value                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                              |
| Size        | 2–3 engineer-weeks                                                                                                                                                                                                        |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md), [UK-02b](UK-02b-ui-fixtures-parity.md)                                                                                                          |
| Unblocks    | [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-06](UK-06-electron-kit.md), [UK-17](UK-17-vue-kit.md), [UK-18](UK-18-svelte-kit.md), [UK-19](UK-19-angular-kit.md), [UK-20](UK-20-react-native-kit.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                        |
| Gates       | the UI fixture runner in `pnpm test`; `pnpm typecheck`                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                 |

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

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] Every UK-02b fixture passes.
- [ ] A test with a fake `PresentationSource` resolves the product accent (and `accentDark` in dark) with no integrator input; with no source it falls through to the bundle and then the derived accent.
- [ ] No DOM, React or Lit import in the package (a test asserts it).
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
