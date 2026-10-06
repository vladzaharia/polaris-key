# PX-24 Library "Added just now": for 24 hours a newly added product carries a ring, the quiet text "Added just now" and its download as the tile's lead (EXPERIENCE §0.7, frame 7)

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                   |
| Size        | 0.2–0.4 engineer-weeks                                                                                                                                                       |
| Depends on  | [PX-16](PX-16-discover-page.md), [MO-07](MO-07-portal-library-motion.md)                                                                                                     |
| Unblocks    | none                                                                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | portal e2e in both themes at 1440 and 390, with the linux visual baselines re-recorded (`scripts/portal-baselines.sh`); console CSP parity; `vitest-axe` on the changed tile |
| Human input | none                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Goal

For 24 hours after a product enters the account's Library, its tile carries a ring and the quiet
text "Added just now", leads the Library under the default sort, and makes the product's download
the tile's lead action. After 24 hours the tile is ordinary again. There is no pill, and the ring
is not the only signal (the text carries the meaning).

## Why

EXPERIENCE.md §0.6 P1 step 7 (frame 7) and §0.7's "New product in the library" moment: the next
time the person opens Polaris Key after activating from an app, the new product should be first,
with a ring and "Added just now" for 24 hours. MO-07 found it is not on `main` and left it out
because it is a feature, not motion: new copy, a new rule on `addedAt` and a new tile layout
([MO-07](MO-07-portal-library-motion.md), "Corrections found while building"). MO-06's Out list
also pointed it at MO-07. This package is that follow-up (filed 2026-10-06).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [EXPERIENCE.md](../../../../design/EXPERIENCE.md) §0.6 P1 (step 7) and §0.7 (the moments table:
  once per account, respects reduced motion, never a pill); the Library mockup
  `docs/design/experience/08-portal-library-*.png`.
- [PORTAL.md](../../../../design/PORTAL.md) §4.13–§4.15 (the Library tile's anatomy, quick action,
  grid and list) and §4.16 (Discover's just-added state, the precedent).
- [MO-07](MO-07-portal-library-motion.md), its corrections: the Discover tile's just-added ring and
  plate, the ring overlay outside the card's clip, `.pk-lift` on a wrapper, first-load stagger.
- [notes/S-23](../../notes/S-23-motion-system.md) §6 (the patterns, `pk-pop-in`, and the rules, reduced motion included).
- Code: `packages/admin/src/portal/components/LibraryTile.tsx`, `LibraryList.tsx`,
  `DiscoverTile.tsx` (the ring overlay), `portal/model/library.ts` (`addedAt`, `QuickAction`),
  `portal/model/libraryView.ts` (sort), `pages/LibraryPage.tsx`;
  `packages/worker/src/services/identity/portal/library.ts` (`addedAt`).

## Scope

**In:**

- The rule: a product is "just added" while `0 ≤ now − addedAt < 24 h`, decided in the portal model
  (`model/library.ts`), with a test at the edges (just added, 23 h 59 min, 24 h, a future
  `addedAt` from clock skew counted as now, `addedAt` missing).
- The tile in grid (both sizes) and list: a ring (an `aria-hidden` overlay outside the card's clip,
  as on the Discover tile), the quiet text "Added just now" in the tile's reason line, and the
  product's download (the existing `QuickAction`) as the tile's lead. Settle the layout against
  frame 7 and PORTAL.md §4.14–§4.15; when the quick action is "See downloads" or none, the tile keeps
  its normal action.
- Motion: the ring and text appear once per tile per document with MO-07's just-added treatment
  (`pk-pop-in` on the text; the ring fades with `pk-content-in`, see Design notes); never on a
  refetch, a filter, a sort or a view switch; static under reduced motion (both the media query
  and `html[data-motion="reduce"]`).
- Copy: "Added just now", US English.
- The portal fixtures' clock: the Mossgarden fixture is 60 seconds old (`e2e/portalFixtures.ts`), so
  every scenario that shows it changes. Re-record the linux visual baselines
  (`packages/admin/scripts/portal-baselines.sh`, Docker) and review the diff.

**Out** (and where it belongs instead):

- A Worker change to what `addedAt` means (→ a PX-W package, only if the open point below decides
  it is needed).
- Discover's just-added state (done in PX-16 and MO-07).
- The other portal moments of §0.7 ("It's yours", "Your first product!") (→ the packages that own
  their screens).

## Design notes

- **`addedAt` is first contact, not the latest attach.** The Worker answers it as the pairwise
  subject's `created_at` (`library.ts`, `addedAt()`): when the account first got this product. A
  product re-added after **Remove from my library**, or a licence attached to an account that
  already had a subject through an earlier sign-in in the product, keeps the old date and shows no
  ring. Open point for the builder, decided on the recommended option and recorded in this brief:
  **recommended**, accept that for this package (no Worker change, no wire change). The
  alternative, a Worker-side "latest attach" time, is a portal API change with its OpenAPI operation
  and `PORTAL_KIND_PATHS` row (rule 10).
- **First in the Library** holds under the default sort (`recent`, `addedAt` descending,
  `libraryView.ts`); under **By name** the tile keeps its place.
- **The ring fades; it does not scale.** MO-07 found that `pk-pop-in` scales from 0.9, which would
  pass a 1 px ring inside the card's edge, so on the Discover tile the ring fades in (`pk-content-in`,
  opacity only) on an overlay outside the card's clip while the plate pops. Do the same here.
- **Not the only signal** (WCAG 1.4.1): the text says it; the ring decorates.
- **The 24 hours use the browser's clock** against the server's `addedAt` (seconds). A wrong
  device clock can only show or hide a quiet cue, never a policy.

## Steps

1. Re-read EXPERIENCE §0.6 P1, §0.7 and PORTAL.md §4.13–§4.16 with frame 7; verify this brief
   against the code and record any correction here.
2. The rule and its tests in the model.
3. The tile (grid, compact grid, list) with the ring, the text and the lead; component tests and
   `vitest-axe`.
4. Motion and reduced motion; a case in `e2e/libraryMotion.e2e.test.ts`.
5. Re-record the visual baselines and review them; run the green gate and set `--set PX-24
in-review`.

## Acceptance criteria

- [ ] A product added under 24 hours ago shows the ring and "Added just now" and leads its tile with
      the download; at 24 hours it does not (model tests at the edges).
- [ ] Under the default sort the just-added product is first (test).
- [ ] The ring and text appear once per tile per document, never on a refetch, filter, sort or view
      switch, and are static under both reduced-motion settings (e2e: `document.getAnimations()`
      is empty after the interaction).
- [ ] `vitest-axe` passes on the changed tile; the text, not the ring, carries the meaning.
- [ ] The linux visual baselines are re-recorded and `scripts/portal-baselines.sh --check` passes; no
      horizontal page scroll at 360 px.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e`
      reports zero CSP violations.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in
      the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
packages/admin/scripts/portal-baselines.sh --check
```

## Hand-off

MO-13's strips can include the ring once this lands. The open point on `addedAt` is recorded in this
brief either way.

The role agent sets `--set PX-24 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-24
done`.
