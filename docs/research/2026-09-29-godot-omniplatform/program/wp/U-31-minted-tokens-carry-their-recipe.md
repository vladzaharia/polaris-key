# U-31 Minted tokens carry their recipe

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | U: Cloud Sync (S-17) (DX consolidation G: Managed config and Cloud Sync)                         |
| Size        | 0.9–1.2 engineer-weeks                                                                           |
| Depends on  | [U-30](U-30-config-types-in-app-visibility-in-one.md)                                            |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-32](U-32-catalog-templates-cloud-sync-page-minted.md) |
| Role        | `pkey-implementer`                                                                               |
| Plan mode   | no                                                                                               |
| Gates       | `threat-model`                                                                                   |
| Human input | none                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CFG-05** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync).

## Goal

Minted tokens carry their recipe, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CFG-05** in [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **CFG-05**.
- [`audits/config-cloudsync.md`](../../../2026-10-07-dx-consolidation/audits/config-cloudsync.md), for file and line evidence.

## Scope

**In:**

- A catalog mint block; ingest of edge_mint_config from the catalog; legacy edgeMint[] read, then migrated; config.edgeMint.recipes folded into config.catalog; Config -> Edge mint folded into Catalog (approval pill, Approve drawer, Set signing key); console-saved recipes approved under step-up; THREAT-MODEL A5 and the P0-12 rows re-verified.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track G (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CFG-05**; DX consolidation G: Managed config and Cloud Sync.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] When the recipe changes on the server while the approve drawer is open, the drawer stays open, shows the info callout 'The recipe changed while you were reviewing' with the new commit, swaps the comparison, and nothing is approved. The callout is not a toast and never auto-dismisses; a cancelled or failed passkey shows a danger strip above the foot and keeps the comparison; a changed field's comparison expands in place. (admin-2-16)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections (2026-10-17, from the code)

- **No signed document, corpus or wire change.** A recipe never reaches a device document, so the work needs no plan. `ConfigEntry` (in `@polaris-key/catalog`, not `shared-protocol`) gains an optional `mint` block that is authoring-only: ingest and the console's publish lift it into `edge_mint_config`, and the served catalog never carries it. SDK mirrors, the corpus and `PROTOCOL_VERSION` are untouched.
- **"Ingest of edge_mint_config from the catalog"** is the manifest normaliser: `mint` blocks are lifted into `ParsedManifest.edgeMint` (id = the entry's key), so link, resync, approval and the mint route see the one list they already read. No migration (the table is unchanged).
- **`config.edgeMint.recipes` rides `config.catalog`.** Resync used to delete and rewrite every recipe whether or not the catalog was claimed. It now leaves recipes alone while `config.catalog` is claimed (SQL-guarded). The registry entry itself stays: `settings-coverage` needs a home for the `edge_mint_config` table and `product:edgeMint` (the canonical home of a deprecated spelling), and one entry cannot cover two stores yet. Folding the entry away needs that registry feature (follow-up). A `linkExisting` replace-whole plan is unchanged.
- **Approving was not step-up.** `POST …/config/mint/:id/approve` is now a step-up route (route table, `STEP_UP_ROUTES`, the RBAC matrix).
- **Migration of U-30's warning.** `catalog_edge_mint_without_recipe` stays, now meaning "a minted token with neither a `mint` block nor a legacy recipe". A legacy `edgeMint[]` recipe whose id is a minting entry warns `catalog_edge_mint_legacy`, and `pkey validate --fix` moves it into the entry's `mint` block (a recipe with no entry is still read, silently, since moving it would mean inventing an entry). A block and a legacy recipe of one id is the error `edge_mint_recipe_duplicate`.
- New codes (each with a mutation-table entry and the JSON Schema `mintBlock`): `invalid_catalog_mint`, `catalog_mint_not_minted`, `edge_mint_recipe_duplicate`, `catalog_edge_mint_legacy`; the existing `invalid_edge_mint_*`, `invalid_ttl` and `invalid_secret_ref` rules also run on the block.

## Progress and continuation (2026-10-17)

Done: the block (validator, schema, ingest, `--fix`), console publish saving recipes under the catalog's claim, step-up approval, resync claim, the setting fold, the recipe editor and approval pill on the entry form (real-browser look: light 1440, dark 390), docs, threat-model paragraph, skill.

Left for the next slice (UX fold, all in the console):

- Move the Approve drawer (public-mint acknowledgement, Revoke, passkey step-up with the failed state and Try again, the "recipe changed while you were reviewing" callout from the brand-transition section, admin-2-16) onto the catalog entry, then delete the Edge mint page (`EdgeMintPage.tsx`, nav entry `edge-mint`) and redirect its URL to the entry. Today the entry's **Review and approve** opens the existing Edge mint page's drawer.
- The review step's per-entry changed-since-open merge and Copy the diff (U-29 overlap).
- The UX reviewer pass on the built screens.

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

- **Builds or backs 12 mockup item(s):** `config.approve-recipe-approved`, `config.approve-recipe-open-access`, `config.approve-recipe-passkey-failed`, `config.approve-recipe-stale`, `config.approve-recipe`, `config.catalog-invalid`, `config.catalog-review-states`, `config.catalog-review`, `config.entry-draft-stale`, `config.entry-minted-token-no-key`, `config.entry-minted-token`, `config.mint-wizard`.
- `config.approve-recipe-approved`, `config.entry-minted-token-no-key`, `config.entry-minted-token`: The recipe, key and approval live on the catalog entry; remove the Edge mint page (nav entry edge-mint, EdgeMintPage.tsx) and redirect its old URL to the entry.
- `config.approve-recipe-open-access`, `config.approve-recipe-passkey-failed`: Passkey step-up (I-30) on the approve drawer, with the failed state and Try again, named in the acceptance; add the widening warning, commit link and toast.
- `config.catalog-invalid`, `config.catalog-review`: C-24 in the mockup json is the console catalog page (not a work package): the review step, Copy the diff, the invalid state and per-entry changed-since-open merge belong to U-29 and U-31.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Acceptance criteria

- [x] One recipe location (the entry's `mint` block; the console editor writes it, the Edge mint page is now only the approve surface)
- [x] Approval still required before minting (P0-12), now behind a step-up
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/managed-config/{catalog, visibility, minted-tokens, profiles}`; `reference/config-entry`.
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set U-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-31 done`.
