# ST-41 Integration page and Overview card

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)                                                                                                                                                                                                                                                                                   |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on  | [ST-40](ST-40-integration-facts-sdk-sightings.md), [SP-33a](SP-33a-one-integration-content-generator-on.md), [ST-39](ST-39-wizard-kit.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md)                                                                                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-36](I-36-sign-in-integration-card.md), [U-32](U-32-catalog-templates-cloud-sync-page-minted.md), [D-02](D-02-diceroll-after-p1.md), [ST-47](ST-47-legacy-setup-retirement.md), [SP-37](SP-37-developer-docs-reshape.md), [LX-43](LX-43-licensing-presets-1-x-helper-new-major.md), [AX-08](AX-08-pkey-agents-product-repo-block-console-card.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                          |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-05** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-21, UX-61, UX-63, UX-64, UX-65, UX-75.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 4: per-SDK, per-feature links to the library lane through `integrationDocs()` in `docsLinks.ts`, checked against anchors and frontmatter (§3.7). A feature's "Not seen yet" state links `build/troubleshooting`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Renders the review's §4.1–4.2: one drop-in per host, two links, the preconditions. HA-13 and HA-14 land before it shows kit snippets.

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Renders the server and CLI cards (§10): the server card's snippet, two links and Verified, the app card's `client.backend` line, and the CLI card's mount and gate.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Goal

Integration page and Overview card, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-05** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-05**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.

## Scope

**In:**

- console Integration page (nav, routes, palette): SDK picker from sdkFit; per-feature cards with prerequisites, the generated snippet and Verified per platform, hosting the cards built by LX-43 (Licensing), U-32 (Managed config and Cloud Sync), I-36 (Sign-in), P2-11 (Ship builds: updates and channel links) and CM-23 (Commerce); an inline test licence; 'Hide Integration' offered after the first Verified feature, stored in core.setup, never automatic, re-openable from the Overview card; the Overview Integration card replaces TrustPanel, the checklist and Welcome; Devices' empty state links here. Snippets come from SP-33a's generator on today's names; SP-33b moves them to polaris-key.json later with no page change. Absorbs UX-21, UX-61, UX-63, UX-64, UX-65 and UX-75.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-05**; DX consolidation C: Products, onboarding and Integration.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

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

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- The Overview's composition is `products.overview` as of dx-mockups 5ffbe914f (one hero with the computed next step as the only primary, the Integration gauge pane, a feature-card board, the Integration steps rail). The transition guide's older Overview (a 'Continue integration' primary, a feature x platform table) is out of date for composition and copy and is not built; take only the shell treatments from ST-48. (admin-1-03)
- [ ] The brief names the mockup id and commit, and the guide's 'Continue integration' is not built. (admin-1-03)
- Integration snippets use the site's patterns: the SDK picker per feature is a tablist with roving tabindex and Home/End, its selection in the hash query (`sdk=`), logos from the brand service and stack icons; the shared CodeBlock (filename bar, Copy with a live region, notes footer); destination links. (site-06)
- [ ] Playwright keyboard test (ArrowRight, End, Tab order); copy test with the clipboard denied; axe zero at 1440 and 390 in both themes; no horizontal page scroll at 360. (site-06)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Hide is never automatic and is re-openable
- [ ] A product shipping two platforms shows per-platform progress
- [ ] Welcome, TrustPanel and the Overview checklist are gone
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `build/integration`; Verified in every **Check it works**; "Not seen yet" links `build/troubleshooting`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-41 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-41 done`.
