# MO-12 Reduce-motion preference: a Motion row (System, Reduced) beside the theme in the console account menu and in the portal's Account → Appearance, stored per browser and applied as `html[data-motion]` from the entry modules

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 3: after UX-10)                                     |
| Size        | 0.2–0.3 engineer-weeks                                                                   |
| Depends on  | [MO-02](MO-02-motion-layer.md)                                                           |
| Unblocks    | [MO-13](MO-13-motion-qa-closeout.md)                                                     |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no                                                                                       |
| Gates       | admin unit tests and axe; `adminCspParity` (the hashed pre-paint script must not change) |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

Anyone can turn motion down in Polaris Key itself, not only in their OS, and the choice holds across reloads in that browser.

## Why

WCAG 2.3.3 asks for a way to turn off motion from interactions; the OS setting covers most people, an in-app switch covers shared and managed machines (notes/S-23 §6.6).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `src/main.tsx`, `src/portal/main.tsx`, `console/shell/{ThemeMenu,UserMenu}.tsx` and `portal/components/AccountMenu.tsx` after UX-10 merges, `portal/pages/AccountPage.tsx`, `components/theme.tsx` (how the theme is stored).

## Scope

**In:**

- A stored `pk-admin-motion` (`system` | `reduce`), read in both entries before render and written to `html[data-motion]`; the MO-01 tokens and MO-02 layer already honour it.
- A Motion row (System, Reduced) next to the theme control in the console account menu and in the portal's Account → Appearance.

**Out** (and where it belongs instead):

- Server-side storage of the preference (a later account setting, not here).

## Design notes

- Do **not** touch the inline pre-paint script in `index.html` / `manage.html`: its hash is pinned in `packages/worker/src/adminCsp.ts`. Applying the attribute in the entry modules is early enough because nothing animates before first interaction.
- The menus are in flight in `wp/UX-10`; start after it merges.

## Files it touches

`src/main.tsx`, `src/portal/main.tsx`, `console/shell/{ThemeMenu,UserMenu}.tsx`, `portal/components/AccountMenu.tsx`, `portal/pages/AccountPage.tsx`, tests. In flight: `wp/UX-10`.

## Steps

1. Storage and attribute.
2. Console row.
3. Portal row.
4. Tests.

## Acceptance criteria

- [ ] Choosing Reduced sets `html[data-motion="reduce"]` immediately and after reload, and every token duration resolves to 0 ms (test).
- [ ] `adminCspParity` passes without changing `adminCsp.ts`.
- [ ] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
```

## Hand-off

None. The role agent sets `--set MO-12 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-12 done`.
