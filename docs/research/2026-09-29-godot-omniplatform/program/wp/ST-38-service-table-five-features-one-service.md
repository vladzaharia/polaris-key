# ST-38 Service table: six features; one service-off state (absorbs DC-12)

| Field       | Value                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation C: Products, onboarding and Integration)                                                                                                                                                                                                                   |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                                                      |
| Depends on  | none                                                                                                                                                                                                                                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-29](I-29-retire-product-account-toggles-one-app.md), [ST-40](ST-40-integration-facts-sdk-sightings.md), [ST-42](ST-42-create-defaults.md), [ST-44](ST-44-one-home-delete-get-manage-api-summary.md), [ST-46](ST-46-interactive-pkey-init.md), [CM-29](CM-29-commerce-service.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                          |
| Gates       | `console-csp-parity`                                                                                                                                                                                                                                                                                                        |
| Human input | none                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **OB-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.
- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-66.

- Owner 2026-10-07/08: **Commerce is a service** (`commerce`, `requires: ["license"]`, CM-29), the sixth feature. The generic requirement rule, derived from `requires` in `tools/services.json`, applies to every service: a service can be enabled only while all its requirements are on (stable code `<slug>_requires_<req>`); disabling a requirement disables its dependents transitively in the same audited batch, with a confirmation naming every dependent; re-enabling a requirement does not re-enable dependents; a manifest that declares a dependent on with a requirement off is a validator error. This replaces the hand-written coherence edges in `core/services.ts` (Cloud Sync's refusal becomes a cascade).
- Commerce (CM-29) is the sixth feature row; until CM-29 lands, the row is absent and the rule covers the existing services.
- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-29.md`](../plans/CM-29.md) §10: adopts the requirement rule and replaces the pull-on behaviour. Commerce is the sixth feature row, with §3.4's attention state. Adds `console.group`.

## Goal

Service table: six features; one service-off state (absorbs DC-12), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **OB-02** in [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track C, Products, onboarding and Integration](../../../2026-10-07-dx-consolidation/tracks.md#c-products-onboarding-and-integration): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **OB-02**.
- [`audits/products-onboarding.md`](../../../2026-10-07-dx-consolidation/audits/products-onboarding.md), for file and line evidence.
- [`audits/release-distribution.md`](../../../2026-10-07-dx-consolidation/audits/release-distribution.md), for file and line evidence.

## Scope

**In:**

- tools/services.json gains console.group and each feature's switches; gen:services emits them to the console only (SDK constants byte-identical). The Services area shows Licensing, Managed config, Ship builds (release + distribution, In-app updates on by default), Sign-in and Cloud Sync (turns on config and identity); each feature row holds its own switches (Package feeds, Customer portal, Polaris Key storefront visibility, Minted tokens) and its facts as status (Commerce: a storefront is ready); the registration policy is always derived (a declared value gets a validator warning) and the per-slug state is read-only under Advanced; anonymous entry has one home, the Anonymous devices row of license.access; one data-driven service-off state for every service page (UX-66). Release-only products are reported, never migrated.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track C (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **OB-02**; DX consolidation C: Products, onboarding and Integration.
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

- Route tabs (B4) are an underline tablist with roving focus. When the set overflows it scrolls horizontally with an edge fade in the surface colour (not black) and the selected tab scrolled into view; at 480 px and below with five or more tabs keep scrolling (no menu). Counts inside tabs use tabular numerals. This replaces the guide's segmented tabs, which B4 rejects. (admin-3-10)
- [ ] Mockups re-shot at 390 and 1024. (admin-3-10)
- Structure follows the current dx-mockups ids (I-29: identity.app-sign-in, identity.app-sign-in-changes, identity.sign-in-off; I-31: identity.connections, identity.connection*, centred 960 px wizard column; ST-38: commerce.features*, commerce.turn-off-licensing; A-22: commerce.sales\*; ST-39: the stepper where done steps say what was decided, inside the centred wizard column). The guide boards supply chrome only. (admin-3-18)
- [ ] `pkey-ux-reviewer` passes against those mockups in BUILT mode. (admin-3-18)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Discovery, coherence codes and SDK constants byte-identical
- [ ] Turning on Ship builds writes release, distribution and update in one audited batch
- [ ] One service-off component
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): `features/` labels and `src/lib/features.ts` replaced by `console.group`; `operate/console/products`; the coherence-rule table.
- [ ] **Upgrade to 0.9:** a changelog entry whose `replaces` rows name every SDK name, manifest field, CLI form or Action input this package removes and its replacement, so the upgrade table regenerates in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10 item 7).
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-38 done`.
