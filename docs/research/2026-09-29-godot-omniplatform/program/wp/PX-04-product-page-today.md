# PX-04 Product page on today's data: `ProductHeader`, `SectionNav`, `LicenseCard`, Devices with inline confirm, What's new, a first `GetItPanel`, not-found and error states

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase A: today's API)                                                                                                                       |
| Size        | 1–1.6 engineer-weeks                                                                                                                                                                     |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                           |
| Unblocks    | [PX-09](PX-09-get-it-complete.md), [PX-10](PX-10-focused-flows.md), [PX-11](PX-11-package-access.md), [PX-18](PX-18-cloud-sync-section.md)                                               |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

`#/p/:product` shows one product with its header, a section nav that omits absent sections, the license card with a switcher when several licenses exist, devices with an inline remove confirm, release notes and a first Get it panel built from `GET /api/releases`, plus not-found and error states.

## Why

The product page replaces today's separate licenses and downloads lists ([PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page)). PORTAL.md sizes this L (5+ agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.1](../../../../design/PORTAL.md#111-phase-a-rebuild-on-todays-api-no-worker-changes) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page), [PORTAL.md §4.22](../../../../design/PORTAL.md#422-remove-a-device-inline), [PORTAL.md §4.28](../../../../design/PORTAL.md#428-not-found-and-errors), [PORTAL.md §5.2](../../../../design/PORTAL.md#52-new-components), [PORTAL.md §5.3](../../../../design/PORTAL.md#53-status-model)
- `packages/admin/src/portal/App.tsx` (today's license and download views)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `ProductHeader`, `SectionNav` (omits absent sections, including Cloud Sync), `LicenseCard` with the license switcher ("2 licenses · Pro, Edu").
- Devices: `DeviceRow` with inline remove confirm (§4.22) over `DELETE /api/licenses/:p/:id/devices/:deviceId`; consequences spelled out; focus moves to the confirm's heading.
- What's new from releases; a first `GetItPanel` grouping `GET /api/releases` client-side; download tokens through `POST /api/releases/:p/:r/artifacts/:a/token`.
- Not-found and error states (§4.28); "Not included" reasons as visible text.

**Out** (and where it belongs instead):

- Server-shaped downloads, stores, R2 builds, Email me the download (→ PX-09)
- Focused flows (→ PX-10)
- Package access (→ PX-11)
- Cloud Sync section (→ PX-18)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).
- **Cloud Sync** appears only on the product page of a product whose `services.cloudSync` is on; there is no global Cloud Sync page, nav item or account section.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-04:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-04 in-review`.

## Acceptance criteria

- [ ] Device removal shows its consequences, moves focus to the confirm heading and returns it after (tests).
- [ ] Reasons render as text, not only as colour or icon (test).
- [ ] Unknown product slug renders the not-found state with one `h1` (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

PX-09, PX-10, PX-11 and PX-18 add sections and flows to this page.

The role agent sets `--set PX-04 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-04 done`.
