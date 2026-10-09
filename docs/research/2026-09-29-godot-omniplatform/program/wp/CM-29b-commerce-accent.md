# CM-29b Commerce's accent: the Distribution green family

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Phase       | CM: Commerce (DX consolidation H: Channels, storefronts and commerce) |
| Size        | 0.2–0.4 engineer-weeks                                                |
| Depends on  | [CM-29](CM-29-commerce-service.md)                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`) |
| Plan mode   | yes: executes plans/CM-29.md §10 as amended 2026-10-09 (B1)           |
| Gates       | plan-mode, drift-gate, golden-images, ui-snapshots                    |
| Human input | none                                                                  |
| Repo        | `vladzaharia/polaris-key`                                             |

## Brand transition (2026-10-09)

> **Re-scoped by B1** ([Brand transition decisions](../BRAND-TRANSITION.md)). Commerce uses the **Distribution green family**. There is **no ninth vermilion family**. This reverses the owner's 2026-10-08 vermilion choice: the owner's own brand guide, the plrs.im site and the mockups all draw Commerce in green, and a red-orange chrome colour sits beside the danger red on the screens full of Refunded, Charged back and Error pills. The owner can veto. The `commerce` slug, its routes and its behaviour (CM-29) are unchanged; only the colour changes. The accent-distance floor stays **17.5** (no lowering).

## Goal

Commerce renders in the Distribution green family with the shopping-bag glyph and the Pinned K mark (Commerce requires License), in every generated brand output, and contrast passes in both themes.

## Why

One colour story across site, guide, mockups and console, with no floor lowered and no accent that reads as an error. The live site (plrs.im) already ships Commerce in `#39d075` (Services menu tile, scene, page accent and product-story card).

## Read first

- `AGENTS.md`.
- [plans/CM-29.md](../plans/CM-29.md) §10, with its 2026-10-09 amendment.
- `docs/design/BRAND.md` §5 (section accents and the rules they satisfy).
- `packages/brand/src/tokens/source.ts`, `packages/brand/test/accents.test.ts` and `contrast.test.ts`.

## Scope

**In:**

- **Tokens** (`src/tokens/source.ts`). `SERVICE_IDS`, `SERVICE_LABEL` gain `commerce`; `SERVICE_FAMILY.commerce` is the Distribution green family (`green`); `SERVICE_MARK` is unchanged in kind (Pinned K). `[data-service="commerce"]` is generated from the alias. No new family, no new tokens.
- **Tests.** `accents.test.ts` allows exactly one declared shared-family pair (`commerce` with `distribution`) and keeps every floor unchanged (ΔE00 17.5, ΔEOK 0.085, violet 13). The family test pins `SERVICE_FAMILY.commerce`.
- **Kit rule.** Links inside Commerce use strong text, because green reads close to success; the accent never encodes status.
- **Console icon.** `tools/services.json` gives commerce the `ShoppingBag` icon (CM-29 carries the file).
- **BRAND.md** §5.2 records the decision with the date (B1); the docs editor owns the wording.
- **Generated.** `gen:brand` regenerates the CSS, `tokens.json`, the Swift and Godot brand tokens and `[data-service="commerce"]`; `brand proofs` re-renders `preview/proofs/accents-{dark,light}.png`; the preview is rebuilt.

**Out** (and where it belongs instead):

- The commerce service itself (→ CM-29).
- Recolouring the website: nothing to recolour, the site already uses green.

## Design notes

- Runs on CM-29's branch: `packages/brand/test/services.test.ts` pins `SERVICE_IDS` to `tools/services.json`, which CM-29 changes. The lead sets both packages done in that PR.
- Packs and Update tangerine are marketing and docs colours only, with no `data-service` (B5).

## Screen acceptance (brand transition, 2026-10-09)

Done when the Themes row holds. This package draws no screens of its own, so the other rows do not apply (EXPERIENCE.md §7.3).

- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 29 mockup item(s):** `commerce.add-to-offer`, `commerce.connect-app-store-error`, `commerce.connect-app-store`, `commerce.create-iap`, `commerce.features-blocked`, `commerce.features-save-failed`, `commerce.features`, `commerce.first-run-connected`, `commerce.first-run`, `commerce.lists-states`, `commerce.offer-new`, `commerce.offer-price-failed`, `commerce.offer-price-invalid`, `commerce.offer-price`, `commerce.offer-stop-selling`, `commerce.offer`, `commerce.offers-empty`, `commerce.offers-import`, `commerce.offers`, `commerce.purchase-renewal`, `commerce.purchase`, `commerce.purchases-empty`, `commerce.purchases-no-results`, `commerce.purchases`, `commerce.restore`, `commerce.sales-wizard`, `commerce.sales`, `commerce.storefronts`, `commerce.turn-off-licensing`.

## Acceptance criteria

- [ ] The decision is recorded in BRAND.md §5.2 'Owner decisions' with the date, and CM-29b's scope matches it.
- [ ] `SERVICE_FAMILY.commerce` is the Distribution green family; no vermilion family exists; every floor, including 17.5, is unchanged.
- [ ] `pnpm gen:brand -- --check` and `pnpm --filter @polaris-key/brand test` pass; commerce renders green in both themes in the preview.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```
mise exec node@22 -- pnpm gen:brand -- --check
mise exec node@22 -- pnpm --filter @polaris-key/brand test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set CM-29b in-review` when it hands off. After review, the lead adds the last commit of CM-29's PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CM-29b done`.
