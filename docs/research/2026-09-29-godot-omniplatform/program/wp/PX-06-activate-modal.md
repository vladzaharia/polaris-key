# PX-06 Activate license modal: `KeyField`, `ActivateDialog` mounted in the shell, opened from header, bar, ⌘K, empty state and `/activate?key=`, inline errors from today's claim codes

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                           |
| Unblocks    | [PX-17](PX-17-activate-confirm.md)                                                                                                                                                       |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

Activate license is a modal, never a page: `ActivateDialog` with `KeyField` is mounted in the shell and opens from the header button, the phone pill, ⌘K, the empty Library and `/activate?key=` (prefilled, with a signed-out round trip), adds the key through `POST /api/claim/license-key`, and lands focus on the product's `h1`.

## Why

Owner decision: Activate license is a right-aligned header button opening a modal ([PORTAL.md §4.17](../../../../design/PORTAL.md#417-activate-license-the-modal)); apps and emails deep-link to it ([PORTAL.md §4.18](../../../../design/PORTAL.md#418-activate-license-deep-link)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.17](../../../../design/PORTAL.md#417-activate-license-the-modal), [PORTAL.md §4.18](../../../../design/PORTAL.md#418-activate-license-deep-link), [PORTAL.md §4.19](../../../../design/PORTAL.md#419-activate-license-errors), [PORTAL.md §5.2](../../../../design/PORTAL.md#52-new-components)
- `packages/worker/src/services/identity/portal/api.ts` (claim route and its error codes)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `KeyField`: mono, paste-first, wraps, validates the `pkey_<product>_<22 base64url>` shape, trims whitespace only.
- `ActivateDialog` enter → done (the confirm step arrives with G22 in PX-17); `prefill` and `fromProduct` props; bottom sheet on phones.
- Entry points: header, bottom-bar pill, ⌘K, empty state, `/activate?key=` (signed out → login card → back to the modal with the key).
- Inline errors mapped from today's claim codes (§4.19).

**Out** (and where it belongs instead):

- Confirm step with art, entries notice and `product=` context (→ PX-17)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **License keys** are the real format `pkey_<product>_<22 base64url>`; `KeyField` never groups or changes case and trims whitespace only.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-06:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-06 in-review`.

## Acceptance criteria

- [ ] Deep-link tests signed in and signed out (the key survives the sign-in round trip).
- [ ] After adding, focus lands on the product's `h1` (test).
- [ ] Each of today's claim error codes renders inline copy from §4.19 (tests).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-17 adds the confirm step and app deep-link context on this dialog.

The role agent sets `--set PX-06 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-06 done`.
