# PX-10 Focused flows: free-device and download (`FocusedFlow`, return-URL allowlist)

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-04](PX-04-product-page-today.md), [PX-W1](PX-W1-library-api-media.md)                                                                                                                |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

`#/p/:product/free-device?for=&return=` and `#/p/:product/download?platform=` render in minimal chrome (`FocusedFlow`) and return to the app only when the return URL matches a scheme or origin the product declares.

## Why

Targets of `manageUrl` and email links ([PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §4.25](../../../../design/PORTAL.md#425-device-limit-focused-flow)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.3](../../../../design/PORTAL.md#33-routes), [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §4.25](../../../../design/PORTAL.md#425-device-limit-focused-flow)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `FocusedFlow` with the two flows; return-URL allowlist against the product's declared redirects.

**Out** (and where it belongs instead):

- `manageUrl` on the wire (→ PX-W8)

## Design notes

- **Return URLs** are accepted only when they match a declared scheme or origin; otherwise the flow ends on the product page (§3.3).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-10:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-10 in-review`.

## Acceptance criteria

- [ ] Return-URL allowlist tests (declared, undeclared, malformed).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-W8's `manageUrl` points here.

The role agent sets `--set PX-10 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-10 done`.
