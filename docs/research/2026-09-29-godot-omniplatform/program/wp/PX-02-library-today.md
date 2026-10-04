# PX-02 Library on today's data: client grouping of `GET /api/licenses`, status model, `ProductArt` fallback, tiles and hero, 1 / 2–7 / 8+ layouts, `AttentionShelf`, `QuickAction`, empty state

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                           |
| Unblocks    | [PX-03](PX-03-library-scale.md), [PX-08](PX-08-library-api.md)                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

The default route shows the person's Library built from today's `GET /api/licenses`, grouped by product client-side, with one status per product from the §5.3 precedence, the right layout for one, a few or many products, an attention shelf and the resolved quick action, and an honest empty state.

## Why

The Library is the portal's home ([PORTAL.md §3.1](../../../../design/PORTAL.md#31-model)); it must ship on today's API so the first cut does not wait on the Worker ([PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.12](../../../../design/PORTAL.md#412-library-empty), [PORTAL.md §4.13](../../../../design/PORTAL.md#413-library-one-product), [PORTAL.md §4.14](../../../../design/PORTAL.md#414-library-a-few-products-27), [PORTAL.md §4.15](../../../../design/PORTAL.md#415-library-many-products-8-grid-and-list)
- [PORTAL.md §5.2](../../../../design/PORTAL.md#52-new-components), [PORTAL.md §5.3](../../../../design/PORTAL.md#53-status-model), [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution)
- `packages/admin/src/portal/api.ts` and `packages/admin/src/portal/format.ts`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Client grouping of `GET /api/licenses` by product; the best license per product by status precedence (§5.3).
- Status model with icon plus word pills and reason lines; past dates never shown as "Expires …".
- `ProductArt` with the flat tint-and-letter fallback (no gradients); `LibraryTile`, `LibraryHero`; the 1 / 2–7 / 8+ layouts; `AttentionShelf`; `QuickAction` per §5.4 from the data available today.
- The empty state (§4.12) with Activate license; the Discover teaser stays hidden until G24 (PX-W10).

**Out** (and where it belongs instead):

- Real art, seats, server reasons and the Discover count (→ PX-08)
- Toolbar, list view and ⌘K (→ PX-03)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).
- Status is computed client-side from existing fields until G1/G5 land (§5.3); keep the function isolated so PX-08 can swap in the server's status.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-02:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-02 in-review`.

## Acceptance criteria

- [ ] Unit tests cover every status precedence row in §5.3 and every quick-action row in §5.4 that today's data can express.
- [ ] The three layouts render from fixtures with 1, 4 and 9 products (tests).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-03 adds the toolbar, list and palette on these components; PX-08 replaces client grouping with `GET /api/library`.

The role agent sets `--set PX-02 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-02 done`.
