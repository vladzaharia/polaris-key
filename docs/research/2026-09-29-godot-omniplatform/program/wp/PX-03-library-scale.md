# PX-03 Library scale features: `LibraryToolbar`, `LibraryList`, `JumpPalette` (⌘K) from 8 products

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-02](PX-02-library-today.md)                                                                                                                                                          |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | owner answer to PORTAL.md Q-3 (List view by default above 6 products on phones; recommended yes)                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

From 8 products the Library gains a toolbar (search, filter chips, sort, Grid/List), a list view, and a ⌘K jump palette, all keyboard-operable, with the query state kept in the URL.

## Why

Large libraries need search and a dense view ([PORTAL.md §4.15](../../../../design/PORTAL.md#415-library-many-products-8-grid-and-list)), and the palette is the fast path to any product or action ([PORTAL.md §4.27](../../../../design/PORTAL.md#427-jump-to-a-product-k)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.15](../../../../design/PORTAL.md#415-library-many-products-8-grid-and-list), [PORTAL.md §4.27](../../../../design/PORTAL.md#427-jump-to-a-product-k), [PORTAL.md §8](../../../../design/PORTAL.md#8-responsive-rules), [PORTAL.md §9](../../../../design/PORTAL.md#9-accessibility)
- `packages/admin/src/ui/data-table` (client mode), `ui/SegmentedControl`, `ui/Kbd`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `LibraryToolbar` with `?view=grid|list`, `?q=`, `?filter=attention|games|apps`, `?sort=recent|name` (§3.3).
- `LibraryList` on `ui/data-table` in client mode; on phones rows drop columns and keep the status pill under the name (§8).
- `JumpPalette`: ⌘K and `/` shortcuts, arrow-key navigation, full-screen on phones; Activate license as an action.

**Out** (and where it belongs instead):

- Product-page and Cloud Sync palette actions (→ PX-04, PX-18)

## Design notes

- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).
- §12 Q-3 (List by default above 6 products on phones) is still open; implement the recommended default behind one constant.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-03:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-03 in-review`.

## Acceptance criteria

- [ ] Keyboard tests: `/` focuses search, ⌘K opens the palette, arrows move, Enter navigates, Escape returns focus to the opener.
- [ ] axe passes on the open palette.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-04 and PX-18 register their actions in the palette.

The role agent sets `--set PX-03 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-03 done`.
