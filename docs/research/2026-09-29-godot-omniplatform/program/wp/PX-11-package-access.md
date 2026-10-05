# PX-11 Package access: `PackageAccessCard` and the one-time registry token dialog on the product page

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-04](PX-04-product-page-today.md), [F-21](F-21-registry-auth.md)                                                                                                                      |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | owner answer to PORTAL.md Q-1 / G14 (fix F-20 to `/api/…` and a `#/p/<product>/package` login URL, or add a `/portal` alias; recommended: fix the plan, no alias)                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

The product page's Package access section lists registry tokens and creates one in a non-dismissable one-time dialog, on F-21's registry auth, at the path settled by Q-1 (G14).

## Why

Registry tokens are a license feature ([PORTAL.md §4.21](../../../../design/PORTAL.md#421-package-token-created)); the F-20 path mismatch must be settled first (G14). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.21](../../../../design/PORTAL.md#421-package-token-created), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close), [PORTAL.md §12](../../../../design/PORTAL.md#12-questions-for-the-owner)
- `wp/F-21-registry-auth.md`, `plans/F-20.md`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `PackageAccessCard`; token creation in `ui/OneTimeSecretPanel` inside a non-dismissable `ui/Dialog`.

**Out** (and where it belongs instead):

- Registry auth itself (→ F-21)

## Design notes

- G14 is an owner decision (Q-1), not a work package; the graph records it as a human input.

## Corrections (verified against the code, PX-11)

- **Q-1 / G14 is settled by the merged code:** F-21 serves the portal token API at
  `GET|POST /api/licenses/<product>/<licenseId>/registry-tokens` and
  `DELETE …/registry-tokens/<tokenId>` (the portal router strips `/api`; there is no `/portal`
  alias, as PORTAL.md recommended). The `/portal/api/…` spelling in F-21's brief and in the
  handler's comment is the plan's wording, not a served path. The card's deep link is
  `#/p/<product>/package`, a product-page section. No owner input was needed to build on it; the
  human-input line stays for the lead to close.
- **What the API returns shapes the card:** `available` (a non-public feed exists; the card and
  its TOC entry and pill show only then), `licenseUsable`, `registryOrigin`, the feeds (ecosystem,
  access mode, base URL) and the account's tokens for the selected licence. It does not return
  the feed's namespace, so the npm snippet keeps the `@scope` placeholder that
  `renderFeedSetup` prints without one (follow-up for F-21: add the namespace to the `GET`).
- **No "Renew"** on a token row (the mockup shows one): there is no renew route; a token near
  expiry shows the amber pill and the person creates a new one.
- The one-time dialog is `ui/OneTimeSecretDialog`: Escape, the close button and a scrim click
  ask "Close without copying?" instead of closing; **Done** waits for Copy or the "I've stored
  this token" tick.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-11:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-11 in-review`.

## Acceptance criteria

- [ ] Non-dismissable dialog test (Escape and backdrop do not close it before the token is copied or acknowledged).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

none beyond the product page.

The role agent sets `--set PX-11 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-11 done`.
