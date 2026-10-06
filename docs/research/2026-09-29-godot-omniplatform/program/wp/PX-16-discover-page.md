# PX-16 Discover page: `DiscoverTile`, Add to library, just-added state, empty state; teaser on the empty Library

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-08](PX-08-library-api.md), [PX-W10](PX-W10-discover.md)                                                                                                                              |
| Unblocks    | [MO-07](MO-07-portal-library-motion.md), [PS-05](PS-05-storefront-portal-ui.md)                                                                                                          |
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

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-16:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-16 in-review`.

## Acceptance criteria

- [ ] Add mints once (double-click test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## S-21 note (2026-10-05)

[S-21](../../notes/S-21-polaris-storefront.md) turns Discover into the Polaris Key storefront. `GET /api/discover` keeps
`reason` and `offer` as the first obtain path and only adds fields
([PS-04](PS-04-storefront-portal-api.md)), so nothing here changes. Keep `reasonCopy` a table
keyed by reason code so [PS-05](PS-05-storefront-portal-ui.md) can add `open`, `store_owned`,
`email_domain` and group labels without restructuring the tile.

## Hand-off

none.

The role agent sets `--set PX-16 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-16 done`.
