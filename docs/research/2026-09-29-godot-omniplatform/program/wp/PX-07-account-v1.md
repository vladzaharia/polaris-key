# PX-07 Account v1: sign-in email, Appearance, Delete account, Sign out; section scaffold for Sign-in methods

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                           |
| Unblocks    | [PX-13](PX-13-account-v2.md), [PX-22](PX-22-account-profile.md)                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

`#/account` (behind the account menu) shows the sign-in email, Appearance, Delete account with a typed confirmation over `DELETE /api/me`, and Sign out, with the section scaffold (`profile`, `methods`, `products`, `sessions`, `appearance`, `data`) ready for later packages.

## Why

The account page is the home of sign-in methods and profile later ([PORTAL.md §4.26](../../../../design/PORTAL.md#426-account)); v1 ships what today's API supports. PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.26](../../../../design/PORTAL.md#426-account), [PORTAL.md §3.3](../../../../design/PORTAL.md#33-routes)
- `packages/worker/src/services/identity/portal/api.ts` (`GET|DELETE /api/me`)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Account sections scaffold with `#/account/:section` routing.
- Sign-in email (read-only), Appearance (theme), Delete account with typed confirm, Sign out.

**Out** (and where it belongs instead):

- Sign-in methods, connected products, sessions, export (→ PX-13)
- Profile (→ PX-22)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-07:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-07 in-review`.

## Acceptance criteria

- [ ] Delete account requires the typed confirmation and is disabled until it matches (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-13 fills Sign-in methods, products and sessions; PX-22 fills Profile.

The role agent sets `--set PX-07 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-07 done`.
