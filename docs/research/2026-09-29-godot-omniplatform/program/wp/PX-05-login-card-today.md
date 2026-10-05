# PX-05 `LoginCard` on today's auth: card frame with header slot and product context, IdP display-name button, email link with the honest sent screen, resend and change email, no-method and network states

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                           |
| Unblocks    | [PX-12](PX-12-login-card-v2.md)                                                                                                                                                          |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

Every signed-out entry renders the one `LoginCard`: lockup, card with header/body/footer slots, a context header from `GET /api/capabilities?product=`, today's OIDC button labelled with the IdP's display name, and the email magic link with an honest "sent" screen, resend and change email, plus explicit no-method and network-error states.

## Why

One login card is an owner decision ([PORTAL.md §10.3](../../../../design/PORTAL.md#103-s-16-and-s-17-dependencies-in-the-order-they-unlock-ui) closing note); the frame must exist on today's auth so PX-12 only adds methods. PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.1](../../../../design/PORTAL.md#41-the-login-card), [PORTAL.md §4.2](../../../../design/PORTAL.md#42-product-context), [PORTAL.md §6.1](../../../../design/PORTAL.md#61-rules), [PORTAL.md §6.4](../../../../design/PORTAL.md#64-error-copy)
- `packages/worker/src/services/identity/portal/auth.ts` (`/login`, `/callback`, `/magic/verify`, `POST /api/magic/start`)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `LoginCard` frame (centred 456 px on the star field; full-width on phones) with `header`/`body`/`footer` slots and step focus management.
- `CardHeader` `context` variant fed by `capabilities?product=`.
- IdP display-name button; email link with the sent screen, resend countdown and change email; magic-link re-check (BroadcastChannel).
- No-method state and a network-error state distinct from signed out.

**Out** (and where it belongs instead):

- Identifier-first, code entry, passkeys, Apple/Google/Steam, license-key path, usual-method hint (→ PX-12)
- App and device headers (→ PX-14)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).
- **Providers** (owner decisions): one login card for every entry; the provider row is logo-only Apple, Google and Steam, filtered per product by where it ships; no Discord anywhere.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-05:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-05 in-review`.

## Acceptance criteria

- [ ] Magic-link re-check tests (another tab completes sign-in).
- [ ] A network failure renders the network state, not the signed-out card (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-12 fills `MethodStack`; PX-14 adds the `app` and `device` header variants; PX-21 adds the email gate step.

The role agent sets `--set PX-05 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-05 done`.
