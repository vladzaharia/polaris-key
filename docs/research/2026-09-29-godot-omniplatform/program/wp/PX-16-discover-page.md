# PX-16 Discover page: `DiscoverTile`, Add to library, just-added state, empty state; teaser on the empty Library

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-08](PX-08-library-api.md), [PX-W10](PX-W10-discover.md)                                                                                                                              |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

`#/discover` lists offers as `DiscoverTile`s with terms and the always-visible reason, Add to library mints once and shows the just-added state (also after reload via `?added=`), the empty state renders, and the empty Library shows the teaser.

## Why

Discover is the second nav item ([PORTAL.md §4.16](../../../../design/PORTAL.md#416-discover)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.16](../../../../design/PORTAL.md#416-discover), [PORTAL.md §4.12](../../../../design/PORTAL.md#412-library-empty)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `DiscoverTile`, add, just-added, empty; the Library teaser; Discover visible in the nav.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- Reasons are always shown (owner decision Q-6).

## Corrections (verified against the code, PX-16)

- **Base.** PX-08 (a dependency) is in review on `wp/PX-frontend-wave2`, not on `main` or on
  the given base (`wp/PX-W10-discover-api`), so this branch merges both. The Library, its nav
  count and `useLibrary` are PX-08's; PX-16 only adds to them.
- **Reasons the Worker sends today:** `free_with_account` ("Free with a Polaris Key account") and
  `group:<group>` ("For members of <group>"). Any other code gets the honest generic line
  "Offered to your account by its developer", so a later policy (email domain, beta) shows a
  reason before the page learns its words. All wording lives in `portal/model/discover.ts`; it
  words the terms the Worker sends and never derives licence terms itself (S-19).
- **Just-added after a reload:** `GET /api/discover` stops listing a product once it is held, so
  `#/discover?added=<p>` rebuilds that tile from the library item (art, tier, terms) with the
  line "Added from Discover, at no cost". `?added=` for a product the library doesn't hold is
  ignored.
- **Mints once:** a per-product in-flight guard outside React state (two clicks in one tick),
  the busy button, and the Worker's idempotent claim. A 409 `not_eligible` says
  "<Developer> stopped this offer." on the tile and removes its Add; other failures keep Add for
  a retry.
- **Empty state:** `h1` stays "Discover" (one `h1` per screen, §9); "Nothing to add right now" is
  the `h2`, as mockup 25 shows. A Worker without `/api/discover` (404) shows this empty state.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-16:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-16 in-review`.

## Acceptance criteria

- [x] Add mints once (double-click test).
- [x] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [x] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [x] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

none.

The role agent sets `--set PX-16 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-16 done`.
