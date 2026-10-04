# PX-09 Get it, complete: server detection, Change platform, Extras, Also yours on, phone actions, Email me the download, public link-out, R2 downloads

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-04](PX-04-product-page-today.md), [PX-W2](PX-W2-downloads-stores.md), [PX-W3](PX-W3-licensed-r2-downloads.md), [PX-W7](PX-W7-emails.md)                                              |
| Unblocks    | [PX-19](PX-19-portal-docs.md)                                                                                                                                                            |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

The product page's Get it panel uses server detection and per-platform groups, offers Change platform and Extras, lists "Also yours on" store links, swaps downloads for phone actions, sends "Email me the download", links public products out to `dl.plrs.im/<product>`, and downloads R2-hosted licensed builds.

## Why

Completes the product page's main job ([PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page), [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page), [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `GetItPanel`, `FileRow`, `StoreHandoff` complete per §4.20 and §5.4 on PX-W2, PX-W3 and PX-W7.

**Out** (and where it belongs instead):

- Focused download flow (→ PX-10)

## Design notes

- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-09:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-09 in-review`.

## Acceptance criteria

- [ ] Platform-grouping tests.
- [ ] Public products link out to `dl.plrs.im/<product>` (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-19 documents the finished panel.

The role agent sets `--set PX-09 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-09 done`.
