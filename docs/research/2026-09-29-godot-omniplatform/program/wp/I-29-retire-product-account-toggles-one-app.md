# I-29 Retire per-product account toggles; one App sign-in page

| Field       | Value                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                       |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                  |
| Depends on  | [HA-12](HA-12-presentation-discovery.md), [ST-38](ST-38-service-table-five-features-one-service.md), [I-30](I-30-connections-one-oidc-relying-party.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-36](I-36-sign-in-integration-card.md), [ST-14](ST-14-portal-settings.md)                                     |
| Role        | `pkey-implementer`                                                                                                                                      |
| Plan mode   | no                                                                                                                                                      |
| Gates       | none beyond the green gate                                                                                                                              |
| Human input | none                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-02** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Goal

Retire per-product account toggles; one App sign-in page, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-02** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **IX-02**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- Stop reading oidc_enabled, magic_enabled, license_key_claim_enabled and auto_link_enabled (email and passkey always on, platform SSO when a connection exists, key claim always on), only after I-30's per-domain enforce exists, so a product that turned magic link off to require SSO keeps that control as an enforced domain; retire portal_product_settings.releases_enabled (portal downloads are gated on Ship builds plus the Polaris Key channel being live); /api/capabilities stops aggregating across tenants; Identity -> Portal and Identity -> Sign-in merge into Product -> App sign-in (Status, Methods derived, Key entry, Consent and terms, Customer portal, Presentation read-only from Core); a lead-run P0-49 dry-run lists products that had a toggle off and the enforced domain that replaces each.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-02**; DX consolidation F: Identity.
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

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Structure follows the current dx-mockups ids (I-29: identity.app-sign-in, identity.app-sign-in-changes, identity.sign-in-off; I-31: identity.connections, identity.connection*, centred 960 px wizard column; ST-38: commerce.features*, commerce.turn-off-licensing; A-22: commerce.sales\*; ST-39: the stepper where done steps say what was decided, inside the centred wizard column). The guide boards supply chrome only. (admin-3-18)
- [ ] `pkey-ux-reviewer` passes against those mockups in BUILT mode. (admin-3-18)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 7 mockup item(s):** `products.settings-presentation`, `identity.app-sign-in-changes`, `identity.app-sign-in`, `identity.connection-enforce`, `identity.sign-in-off`, `identity.sign-in-routes`, `identity.sign-in`.

## Acceptance criteria

- [ ] Four toggles and releases_enabled unread and never registered (ST-14)
- [ ] A product that had magic link off keeps SSO-only sign-in through an enforced domain (test)
- [ ] One App sign-in page
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-29 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-29 done`.
