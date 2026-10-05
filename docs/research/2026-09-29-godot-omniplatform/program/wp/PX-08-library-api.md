# PX-08 Library on `GET /api/library`: real art, seat meters, store-aware quick actions, server reasons, Discover count in the nav

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-02](PX-02-library-today.md), [PX-W1](PX-W1-library-api-media.md)                                                                                                                     |
| Unblocks    | [PX-16](PX-16-discover-page.md)                                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

The Library reads `GET /api/library`: proxied art in `ProductArt`, `SeatMeter`s, store-aware quick actions, server-computed status and reasons, and the Discover count in the nav.

## Why

First shippable cut is Phase A + PX-W1 + PX-08 ([PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.13](../../../../design/PORTAL.md#413-library-one-product), [PORTAL.md §4.14](../../../../design/PORTAL.md#414-library-a-few-products-27), [PORTAL.md §4.15](../../../../design/PORTAL.md#415-library-many-products-8-grid-and-list), [PORTAL.md §5.3](../../../../design/PORTAL.md#53-status-model), [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution), [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Swap client grouping for `GET /api/library`; real art; seat meters (`role="img"` with a text label); server reasons; Discover count.

**Out** (and where it belongs instead):

- Discover page (→ PX-16)

## Design notes

- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-08:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-08 in-review`.

## Acceptance criteria

- [ ] A CSP test with real proxied images reports zero violations.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

PX-16 links from the Discover count.

The role agent sets `--set PX-08 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-08 done`.
