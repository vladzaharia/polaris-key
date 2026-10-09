# PX-01 Portal shell and data layer: pages and components split, TanStack Query, hash router with the §3.3 routes and redirects, `PortalShell`, theme, titles, error mapping, `quiet` and `action` Button variants

| Field       | Value                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                             |
| Depends on  | none                                                                                                                                                                                                                               |
| Unblocks    | [PX-02](PX-02-library-today.md), [PX-04](PX-04-product-page-today.md), [PX-05](PX-05-login-card-today.md), [PX-06](PX-06-activate-modal.md), [PX-07](PX-07-account-v1.md), [PX-W7](PX-W7-emails.md), [PX-20](PX-20-quality-bar.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                                                 |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components                                           |
| Human input | none                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                          |

## Goal

The customer portal SPA at `key.plrs.im` is rebuilt as pages and components on a TanStack Query data layer and a hash router that serves every §3.3 route and redirect, inside a `PortalShell` with Library and Discover navigation, the right-aligned **Activate license** button, the account menu and the phone bottom bar, so that every later PX front-end package only adds pages.

## Why

Today's portal is a single `App.tsx` with ad-hoc fetching and no routing model ([PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes)); the approved redesign ([PORTAL.md §3.1](../../../../design/PORTAL.md#31-model)) needs Library as the default route, Discover as the second nav item, a modal Activate flow reachable from anywhere, and stable redirects from the old hash routes. PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §3.2](../../../../design/PORTAL.md#32-global-elements), [PORTAL.md §3.3](../../../../design/PORTAL.md#33-routes), [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points)
- [PORTAL.md §5.1](../../../../design/PORTAL.md#51-reuse-first), [PORTAL.md §5.2](../../../../design/PORTAL.md#52-new-components), [PORTAL.md §7](../../../../design/PORTAL.md#7-layout-and-visual-details), [PORTAL.md §8](../../../../design/PORTAL.md#8-responsive-rules), [PORTAL.md §9](../../../../design/PORTAL.md#9-accessibility)
- the mockups in [docs/design/portal/](../../../../design/portal/) ([PORTAL.md Appendix A](../../../../design/PORTAL.md#appendix-a--mockup-inventory))
- `packages/admin/src/portal/App.tsx`, `packages/admin/src/portal/api.ts`, `packages/admin/src/portal/main.tsx`, `packages/admin/test/portal.test.tsx`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Split `portal/App.tsx` into pages and components under `packages/admin/src/portal/`; TanStack Query for every portal API call.
- Hash router with the §3.3 routes (Library `#/` default, `#/discover`, `#/p/:product[/:section]`, `#/account[/:section]`) and the redirects (`#/licenses` → `#/`, `#/licenses/:p/:id` → `#/p/:p/license?license=:id`, `#/downloads` → `#/`, `#/profile` → `#/account`, `#/claim?key=` → `#/?activate=<key>`, `#/account/emails|passkeys|linked` → `#/account/methods`); the `/activate?key=` path handler that lands on `#/?activate=`.
- `PortalShell`: compact `PolarisLockup`, Library (count) and Discover nav with the 2 px underline in the service accent of the page it marks (core violet for Library and Discover, B17), **Activate license** right-aligned next to the `AccountMenu` (an outlined button with the key glyph in `accent-fg`), the phone bottom bar (Library · Activate pill · Discover) with safe-area padding, footer "Polaris Key · key.plrs.im · Help · Privacy · Terms".
- Theme persistence; `document.title` "<Page> · Polaris Key"; one error mapping from portal API codes to copy (§6.4).
- `ui/Button` gains the `quiet` and `action` variants (§5.2).

**Out** (and where it belongs instead):

- Library content (→ PX-02), product page (→ PX-04), login card (→ PX-05), Activate modal content (→ PX-06), Account (→ PX-07).
- Discover content and its count (→ PX-16, after PX-W10); until then Discover is hidden from the nav.

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).
- Account is not a top-level page: it lives behind the account menu (§3.2). Discover stays hidden from the nav until G24 (PX-W10) exists (§10.2 fallback).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-01:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-01 in-review`.

## Acceptance criteria

- [ ] `portal.test.tsx` is adapted to the new structure and passes.
- [ ] Every §3.3 redirect has a test; `/activate?key=…` lands on Library with the modal state set.
- [ ] `document.title` reads "<Page> · Polaris Key" on every route (test); the string "Polaris Key Portal" appears nowhere in the portal source.
- [ ] Playwright asserts no horizontal scroll at 360 px on the shell.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-02…PX-07 mount pages into `PortalShell` and its router; PX-06 mounts `ActivateDialog` in the shell; the Button variants are shared with the console.

The role agent sets `--set PX-01 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-01 done`.
