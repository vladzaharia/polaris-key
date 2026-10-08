# UK-28 Android Views interop: `polaris-key-ui-views` with `PolarisKeyActivity` and its result contract, Fragments, XML-inflatable ComposeView views with theme attrs

| Field       | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should) |
| Size        | 1–1.5 engineer-weeks                                                           |
| Depends on  | [UK-09](UK-09-compose-android.md)                                              |
| Unblocks    | none                                                                           |
| Role        | `pkey-sdk-porter`                                                              |
| Plan mode   | no                                                                             |
| Gates       | Roborazzi baselines for the hosted views; the Compose lint equivalents         |
| Human input | none                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                      |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive condition (the note): Android Views package; the Views recipe ships in UK-09. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Android Views package; the Views recipe ships in UK-09.

- Optional now (was required).

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18, inherited from UK-09 (see [hosted surfaces](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#hosted-surfaces)).
- **In this kit:** Hosts UK-09's composables in `ComposeView`. The Activity is edge-to-edge, so DL17's insets reach the content; it handles predictive back and maps its theme attributes onto the kit theme without fixing sizes.
- **Minimum check:** Pixel equality with UK-09's baselines for the hosted states at the phone and tablet rows.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

## Goal

An XML/Fragment Android app (and the Godot Android plugin) uses the Compose kit without writing Compose.

## Why

Many Android apps and the Godot Android plugin are not Compose hosts (§5.1). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 Android Views row
- The UK-09 kit

## Scope

**In:**

- `PolarisKeyActivity` with an `ActivityResultContract`; `PolarisKeyFragment`s; XML-inflatable `ComposeView`-based views with theme attributes.
- XML sample app.

**Out** (and where it belongs instead):

- A second implementation of any screen (never).

## Design notes

- Presentation comes only through the core's `ProductIdentity` seam from the SDK (HA-13, HA-14). This package does not depend on them: it tests the default with a fake source, and the real accessor plugs in without a kit change (UK-41 verifies it).
- Launch locales are English plus `de`, `fr`, `es`, `pt-BR`, `it`, `ja`, `ko`, `zh-Hans`; there is no RTL locale, so no RTL baselines, but layouts stay RTL-safe.

## Steps

1. Headless layer first: the models or controllers, running the UK-02b fixtures.
2. Styled parts, then the drop-in flow, against the mockups.
3. Baselines in both themes, the lint, the sample and the docs pages.
4. Design review against the mockups; record it in the PR.

## Acceptance criteria

- [ ] Every §4.1 component in scope ships in all three layers of §1.3: (a) the drop-in flow, (b) styled parts with the kit's restyle hooks (§3.2), and (c) the headless model.
- [ ] With an empty theme the kit renders the Polaris Key look (§1.1) in the product's accent; `preset: "native"` restyles it to the host (§3.4); every §3.1 theme field is honoured.
- [ ] Product identity resolves integrator → SDK presentation source → bundle → derived accent → ink (§1.2). A test with a fake presentation source (accent, `accentDark`, verified icon) renders the product accent and icon with **zero integrator code**; the kit has no discovery fetch or icon cache of its own (owner decision: one path, via HA-13/HA-14).
- [ ] Every visible string is a catalog key from UK-02a in the launch locales; the cross-kit string lint (UK-15) passes.
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/kotlin/ui-views/src/test/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample `examples/ui/android-views/` runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups (`android.html`) is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :ui-views:testDebugUnitTest )
```

## Hand-off

None.

The role agent sets `--set UK-28 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-28 done`.
