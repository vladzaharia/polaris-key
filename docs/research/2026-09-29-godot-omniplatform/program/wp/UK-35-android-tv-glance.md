# UK-35 Optional: Android TV, Glance and notifications: TV focus and device-code first, a Glance license/update widget, foreground-service pack progress

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (could) |
| Size        | 2–3 engineer-weeks                                                            |
| Depends on  | [UK-09](UK-09-compose-android.md)                                             |
| Unblocks    | none                                                                          |
| Role        | `pkey-sdk-porter`                                                             |
| Plan mode   | no                                                                            |
| Gates       | baselines in both themes; the string lint                                     |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit screens per SIGN-IN.md §5.1: the logo-only SignIn row with native auth behind the logos (D-21); the device-code hand-off URL `key.plrs.im/device` (`/tv` on TV and console; a product `deviceCodeUrl` wins, D-16); the code as two groups of four joined by a hyphen (D-17); the footnote `signin.footer` (D-15); tier and terms only after the server (D-20); LicenseChoice and ReplaceDevice screens with the row anatomy of §3.6 (tier pill with "{n} of {limit} devices" for every license, then "{origin} · {term}" with the origin in plain words, never a license type: "From signing in", "Steam key ending 3WPLDA", "From Steam"; owner decision 2026-10-05, **Lifetime**); DeviceLimit titled **Replace a device**.

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

- **The one sign-in form** (SIGN-IN.md §3.17, UI-KITS §1.3): device code first, so the card chooses the license (SIGN-IN.md D-82); the form shows the code, then Done. Steps morph in place; nothing stacks on the form except the system confirm for Replace where the platform expects one (D-80).

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive with a product ask. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Android TV, Glance and notifications. Revive with a product ask.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18 (DL14: a QR on Android TV only).
- **In this kit:** Android TV follows the Compose TV screens already built: two panes, the QR in the end pane at min(200 dp, 40 % of the height), first focus on Use a license key instead, a 3 dp ring and 1.05 scale, overscan of 48 dp horizontally and 27–32 dp vertically, Back cancels. Glance uses `GlanceTheme` (the native preset by nature) with the product's icon and one action. The progress notification uses catalog strings and the product's icon.
- **Minimum check:** The TV row with a focus pass; Glance at its size classes and the notification, both schemes.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Goal

The Android TV and Glance surface exists over the existing core, with no second state machine, and is baselined in both themes.

## Why

A could row of §5.1; UpdateProgress names the foreground-service notification (§4.3). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 could rows
- The kit it extends

## Scope

**In:**

- TV focus and device-code first; Glance widget; foreground-service progress notification; snapshots.

**Out** (and where it belongs instead):

- A second state machine (never).

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
- [ ] Screenshot baselines exist for every fixture component × state (UK-02b) in **both dark and light**, at the sizes and variants of §7.1 for this kit, committed lossless under `sdks/kotlin/ui/src/test/snapshots/`; a changed baseline fails CI until re-recorded with the reason in the commit.
- [ ] The §7.3 modernity lint passes on this kit, including the RTL-safe layout rule (no physical left/right; no RTL baselines are required).
- [ ] The §4.4 accessibility checks pass on the same renders.
- [ ] The sample runs against the fixture adapters with no live Worker and with `--live` (§6.1).
- [ ] The kit's framework page and its tab on each component page exist in the docs `build/ui/` section (UK-16 scaffold); the kit README is install + one-line flow + link.
- [ ] A design review against the mockups is recorded in the PR (§7.4); any disagreement between mockup and spec is fixed first.
- [ ] `parity.json` for this SDK records the `ui.*` rows this kit proves (UK-02b ids), with snapshot plus fixture-run proofs.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
( cd sdks/kotlin && ./gradlew :ui:testDebugUnitTest )
```

## Hand-off

None.

The role agent sets `--set UK-35 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-35 done`.
