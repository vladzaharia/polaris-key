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

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-05:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-05 in-review`.

## Acceptance criteria

- [ ] e2e: add from a tile, add from the product page, remove an entry; both themes at 1440 and 390 px.
- [ ] Zero CSP violations; axe passes; no horizontal scroll at 360 px.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PS-11 documents the pages.

The role agent sets `--set PS-05 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-05 done`.
