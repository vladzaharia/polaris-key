# PS-05 Portal storefront UI: multi-path Discover tiles and reason copy, the storefront product page `#/discover/:product`, open products in the Library, link-only tiles

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 2: engine and portal)                                                |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                               |
| Depends on  | [PS-04](PS-04-storefront-portal-api.md), [PX-16](PX-16-discover-page.md)                                                                             |
| Unblocks    | [PS-05b](PS-05b-library-entry-downloads.md), [PS-11](PS-11-storefront-closeout.md), [CM-16](CM-16-storefront-integration.md)                         |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                   |
| Gates       | the PORTAL.md §11 green gate; CSP browser test; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new components |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Goal

Discover tiles show every way to add with the S-21 reason copy, `#/discover/:product` is the storefront product page with Add to library, open products live in the Library without a licence card, and link-only tiles offer store links.

## Why

[S-21 §6.5](../../notes/S-21-polaris-storefront.md#65-the-portal-discover-and-the-storefront-page-ps-05).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `docs/design/PORTAL.md` §4.12–4.16, §5, §6; PX-16's `DiscoverTile`, `DiscoverTeaser` and `model/discover.ts`.
- `packages/admin/src/portal/` (pages, components, router).

## Scope

**In:**

- Reason copy table of S-21 §6.5 in `model/discover.ts`; group labels from the API.
- `#/discover/:product` page (listing, screenshots, paths with terms, Add, after Add go to `#/p/:product`); a 404 state identical to an unknown product.
- Library: entry tiles ("Free to use", Get it, Remove from library with inline confirm).
- Link-only tiles: "Get it on <store>" actions, no Add.

**Out** (and where it belongs instead):

- Prices and Upgrade (→ S-22). Codes (→ LX-25).

## Design notes

- Every offer shows why (owner Q-6). No "coming soon" copy. One `h1` per screen.

## Corrections (PS-05 builder, verified against the code)

- **PS-04's interim filter is gone.** `packages/admin/src/portal/api.ts` no longer drops open
  offers, links and library entries (`addableOffers`, `licensedOnly`); `offerFromWire` reads
  PS-04's shape and a pre-PS-04 answer (no `cta`, no `paths`: its reason and terms are the one
  path), and leaves out only what this build cannot show honestly (an action it does not know,
  such as S-22's `buy`, or an Add with no path). The nav's Discover count is the Worker's
  `discoverCount` unchanged: open offers count, links never (S-21 §6.10 item 8, lead decision), so
  it now matches what Discover lists. No Worker change.
- **Get it for an entry has no downloads yet: the API does not serve them.** The downloads view
  (`GET /api/products/<p>/downloads`), the token mint and the redemption all gate on a linked
  licence (`hasLinkedProductLicense`), so an open product's entry gets the plain `404`. The
  entry's page and tile therefore offer the developer's website ("Get it from <developer>"),
  and the page's Get it renders the downloads view as soon as the Worker answers it for an entry
  (no portal change needed then). Follow-up for the Worker: accept a shown library entry beside a
  linked licence on those three gates, for `public` and `authenticated` deliverables only
  (`accountMayDownload` already refuses the rest without a licence), with the threat-model line.
- **An entry's page has no listing.** S-21 §6.5 says the Library's open-product page "shows Get it
  and the listing", but `GET /api/products/<p>` carries no description or screenshots for an
  entry, and `GET /api/discover/<p>` answers `404` for a held product. The page shows the header,
  Get it and Help. Follow-up for the Worker: the entry's product view carries `description`,
  `screenshots` and `shortDescription` from the same listing.
- **The tile's "+1 more way" links to the storefront page**, where every path is listed with its
  terms and the person picks one (a radio group; the first, the Worker's order, is preselected).
  The tile's name opens the storefront page too, so the Discover tile is now a pressable card
  like a Library tile (MO-07's unit test follows).
- **After Add, the storefront page is replaced** (`location.replace`) by `#/p/:product`, whose `h1`
  takes focus: the page no longer exists for the person, so Back skips it. A product the
  library already holds goes straight to its library page (the client's own library, so no
  enumeration).
- **Discover's lede** says "Adding one puts it in your library straight away, at no cost": an open
  product gets no licence. PORTAL.md §4.16's copy is PS-11's to amend.
- **Remove from library** (entries only) is on the entry's tile menu and its page's header menu,
  confirmed inline with focus on **Keep it**; Escape or Keep it returns focus to the menu
  button, and after removal focus moves to the page's `h1` (or the Library's) before the tile
  goes. The free-device flow sends an entry to its product page (nothing to free).
- **The e2e flows and the `library-entry-remove` state are checked from the page top**, as every
  quality-bar state is: scrolled, a tile's name link passes under the sticky header, which axe's
  `target-size` rule reads as an obscured target (a property of the sticky header, not of
  these screens).

- **Discover's just-added state waits for its toast** (`e2e/portalStates.ts`, `discover-added`):
  under emulation the screenshot raced the toast, so the recorded linux baseline sometimes had it
  and sometimes not. The state now waits for "Mossgarden is in your library", and its baselines
  are re-recorded with it (b2a0ac33e).
- **Review fix round.** Add resolves only once the library holds the product
  (`useClaimDiscover` returns the library refetch), so the library page after Add never shows
  "That product isn't in your library" however slow `GET /api/library` is (tested for a licence
  path and an open product). Opened from Discover, the tile's offer seeds the storefront page
  (`placeholderData`), so its header is in the transition's first frame. While the removal runs,
  focus waits on the confirmation group; choosing Remove again refocuses **Keep it**. A
  link-only page says "Get it from a store above" only when there is one (or "from their
  website above").

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-05:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-05 in-review`.

## Acceptance criteria

- [x] e2e: add from a tile, add from the product page, remove an entry; both themes at 1440 and 390 px.
      (`e2e/storefront.e2e.test.ts`, 12 runs; eight storefront states on the quality bar,
      `e2e/portalStates.ts`, with linux baselines.)
- [x] Zero CSP violations; axe passes; no horizontal scroll at 360 px. (Every flow step and every
      new state; `vitest-axe` on the new components in `test/portalStorefront.test.tsx`.)
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
      (GATE GREEN; `test:e2e` 1488 passed, and the full linux baseline check passed after
      re-recording only the states this change moves.)

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PS-11 documents the pages.

Follow-ups (not in this package):

- **PS-05b** (registered): the Worker serves an entry's downloads (the downloads view, the token
  mint and the redemption accept a shown library entry for `public` and `authenticated`
  deliverables) and carries the listing (`description`, `screenshots`, `shortDescription`) on an
  entry's product view.
- **CM-16 / S-22**: the portal names a path on a claim only when the person chose another than
  the first; with priced paths, always send the path kind.
- **PS-11**: Discover's "Only products you can add for free appear here" footnote (link-only
  tiles are shown too), and PORTAL.md §4.16 and §4.20 for the storefront page and entries.
- **Portal shell**: `scroll-padding-top` for the sticky header, and taller tile name links, so a
  scrolled tile's link is never an obscured `target-size` target.
- **Worker**: `DELETE /api/library/<p>` answers `404` when the entry was replaced by a licence
  meanwhile; the portal treats it as removed, which leaves the licence in place (correct), but
  the toast says the product was removed.

The role agent sets `--set PS-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-05 done`.
