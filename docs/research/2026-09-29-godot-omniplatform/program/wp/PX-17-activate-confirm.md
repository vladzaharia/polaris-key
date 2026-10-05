# PX-17 Activate confirm step and deep link from apps: art confirm (G22), entries notice, `product=` context

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-06](PX-06-activate-modal.md), [PX-W5](PX-W5-rename-newkey-preview.md), [PX-W8](PX-W8-manage-url.md)                                                                                  |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W8.md`](../plans/PX-W8.md):** read `#key=` as well as `?key=`, and handle `next=free-device` from the activate link (PX-10 is done, so PX-17 carries the `next=` hand-off to free-device).
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** Q2: the Worker never puts the key in the link. The modal opens with the §4.18 notice and an empty field unless the SDK added a `#key=` fragment (PX-W8 Q2).

## Goal

`ActivateDialog` gains the confirm step from `POST /api/activate/preview` (art header, product, tier, terms, key echo), the entries notice, and `product=` context from app deep links, with every §4.19 error state.

## Why

Confirm before adding, and arrive from apps with context ([PORTAL.md §4.17](../../../../design/PORTAL.md#417-activate-license-the-modal), [PORTAL.md §4.18](../../../../design/PORTAL.md#418-activate-license-deep-link)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.17](../../../../design/PORTAL.md#417-activate-license-the-modal), [PORTAL.md §4.18](../../../../design/PORTAL.md#418-activate-license-deep-link), [PORTAL.md §4.19](../../../../design/PORTAL.md#419-activate-license-errors)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Confirm step, entries notice, `product=` context; all §4.19 errors.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- **License keys** are the real format `pkey_<product>_<22 base64url>`; `KeyField` never groups or changes case and trims whitespace only.
- Out of entries while signed in is a warning, not a block (owner decision Q-5).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-17:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-17 in-review`.

## Acceptance criteria

- [ ] Error-state tests for every §4.19 case.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

none.

The role agent sets `--set PX-17 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-17 done`.
